import { test, describe } from 'node:test';
import assert from 'node:assert';
import { acquireTradeLock, releaseTradeLock } from '../../backend/execution/executionLock.js';

describe('executionLock (Block 8) — in-memory fallback (no Redis)', () => {
  test('second acquire while held returns null', async () => {
    const t1 = await acquireTradeLock('BTC-LOCKTEST');
    assert.ok(t1, 'first lock acquired');
    const t2 = await acquireTradeLock('BTC-LOCKTEST');
    assert.equal(t2, null, 'second lock blocked');
    await releaseTradeLock('BTC-LOCKTEST', t1!);
  });

  test('re-acquire succeeds after release', async () => {
    const t1 = await acquireTradeLock('ETH-LOCKTEST');
    await releaseTradeLock('ETH-LOCKTEST', t1!);
    const t2 = await acquireTradeLock('ETH-LOCKTEST');
    assert.ok(t2, 'lock re-acquired after release');
    await releaseTradeLock('ETH-LOCKTEST', t2!);
  });

  test('release with wrong token does not free another holder lock', async () => {
    const t1 = await acquireTradeLock('SOL-LOCKTEST');
    await releaseTradeLock('SOL-LOCKTEST', 'wrong-token');
    const t2 = await acquireTradeLock('SOL-LOCKTEST');
    assert.equal(t2, null, 'lock still held after wrong-token release');
    await releaseTradeLock('SOL-LOCKTEST', t1!);
  });

  test('passing undefined redis uses in-memory path (no throw)', async () => {
    const t = await acquireTradeLock('XRP-LOCKTEST', undefined);
    assert.ok(t);
    await releaseTradeLock('XRP-LOCKTEST', t!, undefined);
  });
});
