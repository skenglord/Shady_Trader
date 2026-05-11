import Redis from 'ioredis';
import { logger } from '../logging/logger.js';

export class RedisBloomFilter {
  private redis: Redis;
  private key: string;
  private size: number; // Number of bits
  private hashCount: number; // Number of hash functions

  constructor(redis: Redis, key: string, size: number = 1000000, hashCount: number = 3) {
    this.redis = redis;
    this.key = key;
    this.size = size;
    this.hashCount = hashCount;
  }

  private hash(value: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) - hash + value.charCodeAt(i)) & 0xffffffff;
    }
    return Math.abs(hash) % this.size;
  }

  async add(value: string): Promise<boolean> {
    const bits: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      bits.push(this.hash(value, i + 1));
    }

    try {
      const pipeline = this.redis.pipeline();
      for (const bit of bits) {
        pipeline.setbit(this.key, bit, 1);
      }
      await pipeline.exec();
      return true;
    } catch (error) {
      logger.error('Failed to add to Bloom filter', { error: error.message });
      return false;
    }
  }

  async contains(value: string): Promise<boolean> {
    const bits: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      bits.push(this.hash(value, i + 1));
    }

    try {
      const results = await this.redis.mget(...bits.map(bit => `${this.key}:${bit}`));
      return results.every(result => result === '1');
    } catch (error) {
      logger.error('Failed to check Bloom filter', { error: error.message });
      return false; // On error, assume not present
    }
  }

  async clear(): Promise<void> {
    try {
      await this.redis.del(this.key);
    } catch (error) {
      logger.error('Failed to clear Bloom filter', { error: error.message });
    }
  }

  // Get false positive rate estimate
  getFalsePositiveRate(addedItems: number): number {
    return Math.pow(1 - Math.exp(-this.hashCount * addedItems / this.size), this.hashCount);
  }
}

export class DeduplicationEngine {
  private bloomFilter: RedisBloomFilter;
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
    this.bloomFilter = new RedisBloomFilter(redis, 'trade_deduplication', 1000000, 3);
  }

  async isDuplicate(tradeId: string): Promise<boolean> {
    const exists = await this.bloomFilter.contains(tradeId);
    if (!exists) {
      await this.bloomFilter.add(tradeId);
    }
    return exists;
  }

  async resetFilter(): Promise<void> {
    await this.bloomFilter.clear();
    logger.info('Trade deduplication filter reset');
  }

  getStats(): any {
    return {
      filterSize: this.bloomFilter['size'],
      hashCount: this.bloomFilter['hashCount']
    };
  }
}