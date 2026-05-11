import Redis from 'ioredis';
import { logger } from '../logging/logger.js';

export class DataPartitioner {
  private redisInstances: Redis[] = [];
  private shardCount: number;

  constructor(redisUrls: string[], shardCount: number = 16) {
    this.shardCount = shardCount;

    for (const url of redisUrls) {
      this.redisInstances.push(new Redis(url));
    }

    if (this.redisInstances.length === 0) {
      // Fallback to single Redis instance
      this.redisInstances.push(new Redis());
    }
  }

  private getShard(symbol: string): number {
    // Simple consistent hashing using djb2 hash
    let hash = 5381;
    for (let i = 0; i < symbol.length; i++) {
      hash = ((hash << 5) + hash) + symbol.charCodeAt(i);
    }
    return Math.abs(hash) % this.shardCount;
  }

  private getRedisForSymbol(symbol: string): Redis {
    const shard = this.getShard(symbol);
    const instanceIndex = shard % this.redisInstances.length;
    return this.redisInstances[instanceIndex];
  }

  async setSymbolData(symbol: string, key: string, data: any, ttl?: number): Promise<void> {
    const redis = this.getRedisForSymbol(symbol);
    const fullKey = `${symbol}:${key}`;

    try {
      if (ttl) {
        await redis.setex(fullKey, ttl, JSON.stringify(data));
      } else {
        await redis.set(fullKey, JSON.stringify(data));
      }
    } catch (error) {
      logger.error('Failed to set symbol data', { symbol, key, error: error.message });
    }
  }

  async getSymbolData(symbol: string, key: string): Promise<any | null> {
    const redis = this.getRedisForSymbol(symbol);
    const fullKey = `${symbol}:${key}`;

    try {
      const data = await redis.get(fullKey);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Failed to get symbol data', { symbol, key, error: error.message });
      return null;
    }
  }

  async publishToSymbol(symbol: string, channel: string, message: any): Promise<void> {
    const redis = this.getRedisForSymbol(symbol);

    try {
      await redis.publish(`${symbol}:${channel}`, JSON.stringify(message));
    } catch (error) {
      logger.error('Failed to publish to symbol channel', { symbol, channel, error: error.message });
    }
  }

  async subscribeToSymbol(symbol: string, channel: string, callback: (message: any) => void): Promise<void> {
    const redis = this.getRedisForSymbol(symbol);
    const subscriber = redis.duplicate();

    try {
      await subscriber.subscribe(`${symbol}:${channel}`);
      subscriber.on('message', (ch, message) => {
        if (ch === `${symbol}:${channel}`) {
          try {
            const data = JSON.parse(message);
            callback(data);
          } catch (error) {
            logger.error('Failed to parse subscribed message', { channel, error: error.message });
          }
        }
      });
    } catch (error) {
      logger.error('Failed to subscribe to symbol channel', { symbol, channel, error: error.message });
    }
  }

  async invalidateSymbolData(symbol: string, pattern: string): Promise<void> {
    const redis = this.getRedisForSymbol(symbol);

    try {
      const keys = await redis.keys(`${symbol}:${pattern}`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      logger.error('Failed to invalidate symbol data', { symbol, pattern, error: error.message });
    }
  }

  async getPartitionStats(): Promise<any> {
    const stats: any = {};

    for (let i = 0; i < this.redisInstances.length; i++) {
      try {
        const info = await this.redisInstances[i].info('memory');
        stats[`instance_${i}`] = {
          connected: this.redisInstances[i].status === 'ready',
          memory: this.parseRedisMemoryInfo(info)
        };
      } catch (error) {
        stats[`instance_${i}`] = { connected: false, error: error.message };
      }
    }

    return stats;
  }

  private parseRedisMemoryInfo(info: string): any {
    const lines = info.split('\r\n');
    const memory: any = {};

    for (const line of lines) {
      if (line.startsWith('used_memory:')) {
        memory.used = parseInt(line.split(':')[1]);
      } else if (line.startsWith('used_memory_peak:')) {
        memory.peak = parseInt(line.split(':')[1]);
      }
    }

    return memory;
  }

  async close(): Promise<void> {
    for (const redis of this.redisInstances) {
      await redis.quit();
    }
    logger.info('Data partitioner closed');
  }
}

// Global partitioner instance
let globalPartitioner: DataPartitioner | null = null;

export function getGlobalPartitioner(redisUrls?: string[]): DataPartitioner {
  if (!globalPartitioner) {
    globalPartitioner = new DataPartitioner(redisUrls || ['redis://localhost:6379']);
  }
  return globalPartitioner;
}