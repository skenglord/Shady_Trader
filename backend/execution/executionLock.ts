// backend/execution/executionLock.ts
//
// Bug Fix (v6 #6): v4.1 hardcoded a 5000ms lock TTL. On high-latency exchanges
// (OKX/Kraken on slow networks) the order confirmation round-trip can exceed
// 5000ms, releasing the lock while an order is still in flight. Default is now
// 8000ms, configurable via TRADE_LOCK_TTL_MS.
//
// Adapted to this repo: uses *ioredis* (injected), not node-redis. ioredis
// signatures: set(key, val, 'PX', ttl, 'NX') → 'OK' | null; eval(lua, numKeys, key, arg).

import type Redis from 'ioredis';
import { logger } from '../logging/logger.js';
import crypto from 'crypto';

const TTL_MS = parseInt(process.env.TRADE_LOCK_TTL_MS ?? '8000');

// In-memory fallback for development without Redis
const memLocks = new Map<string, string>();

const RELEASE_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

function redisReady(redis?: Redis | null): redis is Redis {
  return !!redis && (redis as any).status === 'ready';
}

export async function acquireTradeLock(symbol: string, redis?: Redis | null): Promise<string | null> {
  const token = crypto.randomUUID();

  if (!redisReady(redis)) {
    logger.warn('Redis unavailable — in-memory trade lock (dev only)', { service: 'executionLock', symbol });
    if (memLocks.has(symbol)) return null;
    memLocks.set(symbol, token);
    setTimeout(() => memLocks.delete(symbol), TTL_MS).unref?.();
    return token;
  }

  const ok = await redis.set(`trade_lock:${symbol}`, token, 'PX', TTL_MS, 'NX');
  return ok === 'OK' ? token : null;
}

export async function releaseTradeLock(symbol: string, token: string, redis?: Redis | null): Promise<void> {
  if (!redisReady(redis)) {
    if (memLocks.get(symbol) === token) memLocks.delete(symbol);
    return;
  }
  await redis.eval(RELEASE_LUA, 1, `trade_lock:${symbol}`, token);
}
