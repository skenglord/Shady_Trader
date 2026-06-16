import { EventEmitter } from 'events';
import { logger } from '../logging/logger.js';

export interface QueueItem {
  id: string;
  data: any;
  priority: 'high' | 'medium' | 'low';
  timestamp: number;
  retries: number;
}

export class BackpressureManager extends EventEmitter {
  private queues: Map<string, QueueItem[]> = new Map();
  private maxQueueDepth = 1000;
  private circuitBreakerThreshold = 500;
  private circuitBreakerResetTime = 30000; // 30 seconds
  private circuitBreakers: Map<string, { tripped: boolean; trippedAt: number }> = new Map();
  private processingStats: Map<string, { processed: number; dropped: number; avgProcessingTime: number }> = new Map();

  constructor() {
    super();
    this.startCircuitBreakerReset();
  }

  private startCircuitBreakerReset() {
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [queueName, breaker] of this.circuitBreakers) {
        if (breaker.tripped && now - breaker.trippedAt > this.circuitBreakerResetTime) {
          breaker.tripped = false;
          logger.info('Circuit breaker reset', { queue: queueName });
          this.emit('circuitBreakerReset', queueName);
        }
      }
    }, 5000);
    interval.unref();
  }

  async enqueue(queueName: string, item: Omit<QueueItem, 'timestamp' | 'retries'>): Promise<boolean> {
    const breaker = this.circuitBreakers.get(queueName);
    if (breaker?.tripped) {
      logger.warn('Queue rejected due to circuit breaker', { queue: queueName });
      this.emit('itemDropped', { queueName, reason: 'circuit_breaker' });
      return false;
    }

    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = [];
      this.queues.set(queueName, queue);
    }

    if (queue.length >= this.maxQueueDepth) {
      // Drop low priority items when queue is full
      if (item.priority === 'low') {
        this.emit('itemDropped', { queueName, reason: 'queue_full' });
        return false;
      }

      // Drop oldest low priority item
      const lowPriorityIndex = queue.findIndex(q => q.priority === 'low');
      if (lowPriorityIndex !== -1) {
        queue.splice(lowPriorityIndex, 1);
        this.emit('itemDropped', { queueName, reason: 'replaced_low_priority' });
      } else {
        // Queue is full and no low priority items to drop
        this.emit('itemDropped', { queueName, reason: 'queue_full_no_low_priority' });
        return false;
      }
    }

    const queueItem: QueueItem = {
      ...item,
      timestamp: Date.now(),
      retries: 0
    };

    // Insert based on priority
    const insertIndex = this.getInsertIndex(queue, queueItem.priority);
    queue.splice(insertIndex, 0, queueItem);

    // Check circuit breaker threshold
    if (queue.length > this.circuitBreakerThreshold) {
      this.tripCircuitBreaker(queueName);
    }

    this.emit('itemEnqueued', { queueName, itemId: item.id });
    return true;
  }

  private getInsertIndex(queue: QueueItem[], priority: string): number {
    const priorityOrder = { high: 0, medium: 1, low: 2 };

    for (let i = 0; i < queue.length; i++) {
      if (priorityOrder[queue[i].priority] > priorityOrder[priority]) {
        return i;
      }
    }

    return queue.length;
  }

  async dequeue(queueName: string): Promise<QueueItem | null> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) {
      return null;
    }

    const item = queue.shift();
    this.emit('itemDequeued', { queueName, itemId: item!.id });
    return item!;
  }

  async peek(queueName: string): Promise<QueueItem | null> {
    const queue = this.queues.get(queueName);
    return queue && queue.length > 0 ? queue[0] : null;
  }

  getQueueDepth(queueName: string): number {
    const queue = this.queues.get(queueName);
    return queue ? queue.length : 0;
  }

  private tripCircuitBreaker(queueName: string) {
    const breaker = this.circuitBreakers.get(queueName) || { tripped: false, trippedAt: 0 };

    if (!breaker.tripped) {
      breaker.tripped = true;
      breaker.trippedAt = Date.now();
      this.circuitBreakers.set(queueName, breaker);

      logger.warn('Circuit breaker tripped for queue', {
        queue: queueName,
        depth: this.getQueueDepth(queueName),
        threshold: this.circuitBreakerThreshold
      });

      this.emit('circuitBreakerTripped', queueName);
    }
  }

  isCircuitBreakerTripped(queueName: string): boolean {
    const breaker = this.circuitBreakers.get(queueName);
    return breaker?.tripped || false;
  }

  recordProcessing(queueName: string, processingTime: number, success: boolean) {
    let stats = this.processingStats.get(queueName);
    if (!stats) {
      stats = { processed: 0, dropped: 0, avgProcessingTime: 0 };
      this.processingStats.set(queueName, stats);
    }

    stats.processed++;
    stats.avgProcessingTime = (stats.avgProcessingTime + processingTime) / 2;

    // Reset circuit breaker if processing is successful
    if (success && this.getQueueDepth(queueName) < this.circuitBreakerThreshold / 2) {
      const breaker = this.circuitBreakers.get(queueName);
      if (breaker?.tripped) {
        breaker.tripped = false;
        logger.info('Circuit breaker auto-reset due to successful processing', { queue: queueName });
        this.emit('circuitBreakerReset', queueName);
      }
    }
  }

  getStats(queueName?: string): any {
    if (queueName) {
      const queue = this.queues.get(queueName);
      const breaker = this.circuitBreakers.get(queueName);
      const stats = this.processingStats.get(queueName);

      return {
        queueName,
        depth: queue ? queue.length : 0,
        maxDepth: this.maxQueueDepth,
        circuitBreakerTripped: breaker?.tripped || false,
        processingStats: stats || { processed: 0, dropped: 0, avgProcessingTime: 0 }
      };
    }

    // Return stats for all queues
    const allStats: any = {};
    for (const [name, queue] of this.queues) {
      allStats[name] = this.getStats(name);
    }
    return allStats;
  }

  clearQueue(queueName: string): void {
    this.queues.delete(queueName);
    this.circuitBreakers.delete(queueName);
    logger.info('Queue cleared', { queueName });
  }
}

// Global backpressure manager instance
let globalBackpressureManager: BackpressureManager | null = null;

export function getGlobalBackpressureManager(): BackpressureManager {
  if (!globalBackpressureManager) {
    globalBackpressureManager = new BackpressureManager();
  }
  return globalBackpressureManager;
}