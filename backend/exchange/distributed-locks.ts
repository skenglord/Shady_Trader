import Redis from 'ioredis';
import { logger } from '../logging/logger.js';

export interface LockOptions {
  ttl: number; // Time to live in milliseconds
  retryCount: number;
  retryDelay: number;
}

export class DistributedLockManager {
  private redisInstances: Redis[];
  private quorum: number;

  constructor(redisInstances: Redis[]) {
    this.redisInstances = redisInstances;
    this.quorum = Math.floor(redisInstances.length / 2) + 1; // Majority quorum
  }

  async acquireLock(resource: string, value: string, options: LockOptions = { ttl: 30000, retryCount: 3, retryDelay: 100 }): Promise<string | null> {
    const { ttl, retryCount, retryDelay } = options;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const lockValue = `${value}:${Date.now()}:${Math.random()}`;
        const acquired = await this.attemptLock(resource, lockValue, ttl);

        if (acquired) {
          return lockValue;
        }

        if (attempt < retryCount) {
          await this.delay(retryDelay * (attempt + 1)); // Exponential backoff
        }
      } catch (error) {
        logger.error('Error acquiring distributed lock', { resource, attempt, error: error.message });
      }
    }

    return null;
  }

  private async attemptLock(resource: string, value: string, ttl: number): Promise<boolean> {
    const promises = this.redisInstances.map(async (redis) => {
      try {
        const result = await redis.set(resource, value, 'PX', ttl, 'NX');
        return result === 'OK';
      } catch (error) {
        logger.warn('Redis instance failed during lock acquisition', { error: error.message });
        return false;
      }
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(Boolean).length;

    return successCount >= this.quorum;
  }

  async releaseLock(resource: string, value: string): Promise<boolean> {
    const promises = this.redisInstances.map(async (redis) => {
      try {
        // Use Lua script to ensure only the lock owner can release it
        const script = `
          if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
          else
            return 0
          end
        `;
        const result = await redis.eval(script, 1, resource, value);
        return result === 1;
      } catch (error) {
        logger.warn('Redis instance failed during lock release', { error: error.message });
        return false;
      }
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(Boolean).length;

    return successCount >= this.quorum;
  }

  async extendLock(resource: string, value: string, additionalTtl: number): Promise<boolean> {
    const promises = this.redisInstances.map(async (redis) => {
      try {
        const script = `
          if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('PEXPIRE', KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        const result = await redis.eval(script, 1, resource, value, additionalTtl.toString());
        return result === 1;
      } catch (error) {
        logger.warn('Redis instance failed during lock extension', { error: error.message });
        return false;
      }
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(Boolean).length;

    return successCount >= this.quorum;
  }

  async isLocked(resource: string): Promise<boolean> {
    const promises = this.redisInstances.map(async (redis) => {
      try {
        const exists = await redis.exists(resource);
        return exists === 1;
      } catch (error) {
        logger.warn('Redis instance failed during lock check', { error: error.message });
        return false;
      }
    });

    const results = await Promise.all(promises);
    const lockedCount = results.filter(Boolean).length;

    return lockedCount >= this.quorum;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Global lock manager instance
let globalLockManager: DistributedLockManager | null = null;

export function getGlobalLockManager(redisInstances?: Redis[]): DistributedLockManager {
  if (!globalLockManager && redisInstances) {
    globalLockManager = new DistributedLockManager(redisInstances);
  }
  return globalLockManager!;
}

// Utility function for executing code with distributed lock
export async function withDistributedLock<T>(
  resource: string,
  lockValue: string,
  options: LockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const lockManager = getGlobalLockManager();
  const acquiredLock = await lockManager.acquireLock(resource, lockValue, options);

  if (!acquiredLock) {
    throw new Error(`Failed to acquire distributed lock for resource: ${resource}`);
  }

  try {
    return await fn();
  } finally {
    await lockManager.releaseLock(resource, acquiredLock);
  }
}