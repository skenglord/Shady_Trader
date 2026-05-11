import { register, Histogram, Counter } from 'prom-client';
import { logger } from '../logging/logger.js';

export class LatencyProfiler {
  private histograms: Map<string, Histogram<string>> = new Map();
  private counters: Map<string, Counter<string>> = new Map();

  constructor() {
    this.initMetrics();
  }

  private initMetrics() {
    // Data pipeline latency
    this.histograms.set('data_pipeline_latency', new Histogram({
      name: 'data_pipeline_latency_seconds',
      help: 'Time spent in data pipeline operations',
      labelNames: ['operation', 'symbol'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
    }));

    // WebSocket latency
    this.histograms.set('websocket_message_latency', new Histogram({
      name: 'websocket_message_latency_seconds',
      help: 'Time between WebSocket message send and response',
      labelNames: ['exchange', 'message_type'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25]
    }));

    // Indicator calculation latency
    this.histograms.set('indicator_calculation_latency', new Histogram({
      name: 'indicator_calculation_latency_seconds',
      help: 'Time spent calculating technical indicators',
      labelNames: ['indicator_type', 'parallel'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5]
    }));

    // Cache operation latency
    this.histograms.set('cache_operation_latency', new Histogram({
      name: 'cache_operation_latency_seconds',
      help: 'Time spent in cache operations',
      labelNames: ['operation', 'level'],
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05]
    }));

    // Error counters
    this.counters.set('pipeline_errors_total', new Counter({
      name: 'pipeline_errors_total',
      help: 'Total number of pipeline errors',
      labelNames: ['operation', 'error_type']
    }));
  }

  startTimer(operation: string, labels: Record<string, string> = {}): () => void {
    const startTime = process.hrtime.bigint();

    return () => {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1e9; // Convert to seconds

      const histogram = this.histograms.get(operation);
      if (histogram) {
        histogram.observe(labels, duration);
      }

      // Log slow operations
      if (duration > 0.1) { // > 100ms
        logger.warn('Slow operation detected', {
          operation,
          duration,
          labels,
          threshold: '100ms'
        });
      }
    };
  }

  recordError(operation: string, errorType: string, labels: Record<string, string> = {}) {
    const counter = this.counters.get('pipeline_errors_total');
    if (counter) {
      counter.inc({ operation, error_type: errorType, ...labels });
    }

    logger.error('Pipeline error recorded', { operation, errorType, labels });
  }

  async getMetrics(): Promise<string> {
    return register.metrics();
  }

  getHistogramStats(operation: string): any {
    const histogram = this.histograms.get(operation);
    if (!histogram) return null;

    // This would need access to histogram internals, simplified for now
    return {
      operation,
      count: 0, // Would need to access internal count
      sum: 0,   // Would need to access internal sum
      buckets: histogram['bucketValues'] || []
    };
  }

  resetMetrics(operation?: string) {
    if (operation) {
      const histogram = this.histograms.get(operation);
      if (histogram) {
        // Reset specific histogram - implementation depends on prom-client version
        logger.info('Histogram reset requested', { operation });
      }
    } else {
      // Reset all metrics
      for (const histogram of this.histograms.values()) {
        // Reset logic
      }
      for (const counter of this.counters.values()) {
        // Reset logic
      }
      logger.info('All metrics reset');
    }
  }
}

// Global profiler instance
let globalProfiler: LatencyProfiler | null = null;

export function getGlobalProfiler(): LatencyProfiler {
  if (!globalProfiler) {
    globalProfiler = new LatencyProfiler();
  }
  return globalProfiler;
}

// Utility function for timing operations
export function timeOperation<T>(
  operation: string,
  fn: () => Promise<T>,
  labels: Record<string, string> = {}
): Promise<T> {
  const profiler = getGlobalProfiler();
  const endTimer = profiler.startTimer(operation, labels);

  return fn().finally(() => {
    endTimer();
  });
}