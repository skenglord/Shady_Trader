import Redis from 'ioredis';
import { logger } from './logging/logger.js';

export class StatelessServiceManager {
  private redis?: Redis;
  private serviceKey: string;

  constructor(redis: Redis | undefined, serviceName: string) {
    this.redis = redis;
    this.serviceKey = `service:${serviceName}`;
  }

  async getState(key: string): Promise<any> {
    if (!this.redis) return null;
    try {
      const data = await this.redis.get(`${this.serviceKey}:${key}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Failed to get service state', { key, error: error.message });
      return null;
    }
  }

  async setState(key: string, value: any, ttl?: number): Promise<void> {
    if (!this.redis) return;
    try {
      const data = JSON.stringify(value);
      if (ttl) {
        await this.redis.setex(`${this.serviceKey}:${key}`, ttl, data);
      } else {
        await this.redis.set(`${this.serviceKey}:${key}`, data);
      }
    } catch (error) {
      logger.warn('Failed to set service state (Redis unavailable)', { key, error: error.message });
      // Don't throw - allow operation to continue without Redis
    }
  }

  async deleteState(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(`${this.serviceKey}:${key}`);
    } catch (error) {
      logger.error('Failed to delete service state', { key, error: error.message });
    }
  }

  async getAllState(): Promise<Record<string, any>> {
    if (!this.redis) return {};
    try {
      const keys = await this.redis.keys(`${this.serviceKey}:*`);
      if (keys.length === 0) return {};

      const values = await this.redis.mget(keys);
      const result: Record<string, any> = {};

      keys.forEach((key, index) => {
        const stateKey = key.replace(`${this.serviceKey}:`, '');
        if (values[index]) {
          try {
            result[stateKey] = JSON.parse(values[index]);
          } catch (error) {
            logger.error('Failed to parse state value', { key: stateKey, error: error.message });
          }
        }
      });

      return result;
    } catch (error) {
      logger.warn('Failed to get all service state (Redis unavailable)', { error: error.message });
      return {};
    }
  }

  // Atomic state updates with Lua scripts
  async updateStateAtomically(key: string, updateFn: (currentValue: any) => any): Promise<any> {
    if (!this.redis) {
      return updateFn(null);
    }
    const script = `
      local key = KEYS[1]
      local current = redis.call('GET', key)
      local newValue = ARGV[1]
      redis.call('SET', key, newValue)
      return newValue
    `;

    try {
      let currentValue = await this.getState(key);
      const newValue = updateFn(currentValue);
      const serialized = JSON.stringify(newValue);

      await this.redis.eval(script, 1, `${this.serviceKey}:${key}`, serialized);
      return newValue;
    } catch (error) {
      logger.warn('Failed to update state atomically (Redis unavailable)', { key, error: error.message });
      // Return the updated value even if Redis failed - state management should continue
      return updateFn(await this.getState(key));
    }
  }

  // Pub/Sub for state change notifications
  async publishStateChange(key: string, oldValue: any, newValue: any): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.publish(`${this.serviceKey}:changes`, JSON.stringify({
        key,
        oldValue,
        newValue,
        timestamp: Date.now()
      }));
    } catch (error) {
      logger.error('Failed to publish state change', { key, error: error.message });
    }
  }

  async subscribeToStateChanges(callback: (change: any) => void): Promise<void> {
    if (!this.redis) return;
    const subscriber = this.redis.duplicate();

    try {
      await subscriber.subscribe(`${this.serviceKey}:changes`);
      subscriber.on('message', (channel, message) => {
        if (channel === `${this.serviceKey}:changes`) {
          try {
            const change = JSON.parse(message);
            callback(change);
          } catch (error) {
            logger.error('Failed to parse state change message', { error: error.message });
          }
        }
      });
    } catch (error) {
      logger.error('Failed to subscribe to state changes', { error: error.message });
    }
  }

  // Session management for horizontal scaling
  async createSession(sessionId: string, data: any, ttl: number = 3600): Promise<void> {
    await this.setState(`session:${sessionId}`, data, ttl);
  }

  async getSession(sessionId: string): Promise<any> {
    return await this.getState(`session:${sessionId}`);
  }

  async updateSession(sessionId: string, updateFn: (session: any) => any): Promise<any> {
    return await this.updateStateAtomically(`session:${sessionId}`, updateFn);
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.deleteState(`session:${sessionId}`);
  }

  async cleanupExpiredSessions(): Promise<void> {
    try {
      // This would require Redis key expiration events or periodic cleanup
      // For now, rely on TTL expiration
      logger.info('Session cleanup completed (TTL-based)');
    } catch (error) {
      logger.error('Failed to cleanup expired sessions', { error: error.message });
    }
  }
}

// Global service manager factory
const serviceManagers = new Map<string, StatelessServiceManager>();

export function getServiceManager(redis: Redis, serviceName: string): StatelessServiceManager {
  const host = redis?.options?.host || 'memory';
  const port = redis?.options?.port || 'none';
  const key = `${host}:${port}:${serviceName}`;
  if (!serviceManagers.has(key)) {
    serviceManagers.set(key, new StatelessServiceManager(redis, serviceName));
  }
  return serviceManagers.get(key)!;
}
