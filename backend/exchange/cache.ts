import Redis from 'ioredis';
import { runQuery } from '../database.js';
import { logger } from '../logging/logger.js';
import { encodeCandle, decodeCandle, ZeroCopyBuffer } from './data-serializer.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class MultiLevelCache {
  private l1Cache: Map<string, CacheEntry<any>> = new Map();
  private redis: Redis;
  private l1MaxSize = 10000;
  private l1CleanupInterval = 60000; // 1 minute
  private zeroCopyBuffer: ZeroCopyBuffer;

  constructor(redis: Redis) {
    this.redis = redis;
    this.zeroCopyBuffer = new ZeroCopyBuffer();
    this.startL1Cleanup();
  }

  private startL1Cleanup() {
    const interval = setInterval(() => {
      this.cleanupExpiredL1Entries();
    }, this.l1CleanupInterval);
    interval.unref();
  }

  private cleanupExpiredL1Entries() {
    const now = Date.now();
    for (const [key, entry] of this.l1Cache) {
      if (now > entry.timestamp + entry.ttl) {
        this.l1Cache.delete(key);
      }
    }
  }

  async get<T>(key: string, fetchFromL3?: () => Promise<T>): Promise<T | null> {
    const now = Date.now();

    // Check L1 cache
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry && now <= l1Entry.timestamp + l1Entry.ttl) {
      return l1Entry.data;
    }

    // Check L2 cache (Redis)
    try {
      const redisData = await this.redis.get(key);
      if (redisData) {
        const entry: CacheEntry<T> = JSON.parse(redisData);
        if (now <= entry.timestamp + entry.ttl) {
          // Promote to L1
          this.setL1(key, entry.data, entry.ttl);
          return entry.data;
        }
      }
    } catch (error) {
      logger.error('Failed to read from Redis cache', { key, error: error.message });
    }

    // Check L3 cache (PostgreSQL) if fetch function provided
    if (fetchFromL3) {
      try {
        const data = await fetchFromL3();
        if (data) {
          // Cache in L2 and L1
          this.set(key, data, 300000); // 5 minutes TTL
          return data;
        }
      } catch (error) {
        logger.error('Failed to fetch from L3 cache', { key, error: error.message });
      }
    }

    return null;
  }

  async set<T>(key: string, data: T, ttl: number = 300000): Promise<void> {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl
    };

    // Set in L1
    this.setL1(key, data, ttl);

    // Set in L2 (Redis)
    try {
      await this.redis.setex(key, Math.ceil(ttl / 1000), JSON.stringify(entry));
    } catch (error) {
      logger.error('Failed to write to Redis cache', { key, error: error.message });
    }

    // For critical data, also persist to L3
    if (this.isCriticalData(key)) {
      await this.persistToL3(key, data);
    }
  }

  private setL1<T>(key: string, data: T, ttl: number): void {
    if (this.l1Cache.size >= this.l1MaxSize) {
      // Simple LRU: remove oldest entry
      const firstKey = this.l1Cache.keys().next().value;
      this.l1Cache.delete(firstKey);
    }

    this.l1Cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  private isCriticalData(key: string): boolean {
    // Consider ATR data and recent candles as critical
    return key.includes('atr') || key.includes('candle') || key.includes('indicator');
  }

  private async persistToL3<T>(key: string, data: T): Promise<void> {
    try {
      if (key.startsWith('candle:') && Array.isArray(data)) {
        // Persist candles to database
        for (const candle of data) {
          await runQuery(`
            INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, timeframe, time) DO NOTHING
          `, [candle.symbol, '1m', candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume]);
        }
      }
    } catch (error) {
      logger.error('Failed to persist to L3 cache', { key, error: error.message });
    }
  }

  async invalidate(pattern: string): Promise<void> {
    // Invalidate L1
    for (const key of this.l1Cache.keys()) {
      if (key.includes(pattern)) {
        this.l1Cache.delete(key);
      }
    }

    // Invalidate L2 (Redis)
    try {
      const keys = await this.redis.keys(`*${pattern}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      logger.error('Failed to invalidate Redis cache', { pattern, error: error.message });
    }
  }

  async warmCache(): Promise<void> {
    try {
      // Warm up critical indicators
      const recentCandles = await runQuery(`
        SELECT * FROM candles
        WHERE time > ?
        ORDER BY time DESC
        LIMIT 1000
      `, [Date.now() - 3600000], 'all'); // Last hour

      for (const candle of recentCandles) {
        const key = `candle:${candle.symbol}:${candle.time}`;
        await this.set(key, candle, 1800000); // 30 minutes
      }

      logger.info('Cache warming completed', { candlesWarmed: recentCandles.length });
    } catch (error) {
      logger.error('Cache warming failed', { error: error.message });
    }
  }

  getStats(): any {
    return {
      l1Entries: this.l1Cache.size,
      l1MaxSize: this.l1MaxSize,
      zeroCopyBufferSize: this.zeroCopyBuffer.getAvailableSpace()
    };
  }

  // Zero-copy operations for high-frequency data
  encodeForTransport(data: any): Buffer {
    if (data.symbol && data.time && data.open) {
      // It's a candle
      return encodeCandle(data);
    }
    return Buffer.from(JSON.stringify(data));
  }

  decodeFromTransport(buffer: Buffer, type: 'candle' | 'json' = 'json'): any {
    if (type === 'candle') {
      return decodeCandle(buffer);
    }
    return JSON.parse(buffer.toString());
  }
}

// Global cache instance
let globalCache: MultiLevelCache | null = null;

export function getGlobalCache(redis?: Redis): MultiLevelCache {
  if (!globalCache && redis) {
    globalCache = new MultiLevelCache(redis);
  }
  return globalCache!;
}