import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMockRunQuery, setMockRunQuery } from '../../backend/database.js';
import { PositionReconciliationEngine } from '../../backend/exchange/reconciliation.js';
import type { AccountExecutionAdapter } from '../../backend/exchange/account-execution-adapter.js';

function adapter(overrides: Partial<AccountExecutionAdapter> = {}): AccountExecutionAdapter {
  return {
    exchange: 'binance', environment: 'testnet', accountId: 'acct-a',
    capabilities: { supportsLiveTrading: true, supportsAuthenticatedReads: true, supportsClientOrderIds: true },
    placeOrder: async () => { throw new Error('unused'); }, getOrder: async () => null,
    listOpenOrders: async () => [], listOrders: async () => ({ items: [], nextCursor: null }),
    listFills: async () => ({ items: [], nextCursor: null }), getBalances: async () => ({}), ...overrides,
  };
}

afterEach(() => clearMockRunQuery());

test('incomplete pagination fails closed without advancing the account checkpoint', async () => {
  const writes: Array<{ sql: string; params: any[] }> = [];
  setMockRunQuery(async (sql: string, params: any[] = []) => { if (sql.includes('INSERT INTO exchange_reconciliation_state')) writes.push({ sql, params }); if (sql.includes('SELECT fill_cursor')) return [{ fill_cursor: '1234' }]; return []; });
  const engine = new PositionReconciliationEngine();
  const exchange = adapter({ listFills: async (_since, cursor) => cursor ? { items: [], nextCursor: 'loop' } : { items: [], nextCursor: 'loop' } });
  await assert.rejects(engine.reconcileAccount(exchange), /cursor repeated/);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /'blocked'/);
  assert.match(writes[0].sql, /status = 'blocked'/);
  assert.equal(writes[0].params[3], 'Exchange pagination cursor repeated; snapshot is incomplete');
});

test('reconciliation reads all pages before successful checkpoint advancement', async () => {
  const writes: Array<{ sql: string; params: any[] }> = [];
  setMockRunQuery(async (sql: string, params: any[] = []) => { if (sql.includes('INSERT INTO exchange_reconciliation_state')) writes.push({ sql, params }); return []; });
  let calls = 0;
  const engine = new PositionReconciliationEngine();
  const exchange = adapter({ listFills: async (_since, cursor) => { calls++; return cursor ? { items: [], nextCursor: null } : { items: [], nextCursor: 'next-page' }; } });
  const result = await engine.reconcileAccount(exchange);
  assert.equal(calls, 2);
  assert.equal(result.ready, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params[2], 'ready');
});

test('read and authentication errors preserve the previous cursor and incidents', async () => {
  const writes: Array<{ sql: string; params: any[] }> = [];
  setMockRunQuery(async (sql: string, params: any[] = []) => { if (sql.includes('INSERT INTO exchange_reconciliation_state')) writes.push({ sql, params }); if (sql.includes('SELECT fill_cursor')) return [{ fill_cursor: '5000' }]; return []; });
  const engine = new PositionReconciliationEngine();
  await assert.rejects(engine.reconcileAccount(adapter({ listOpenOrders: async () => { throw new Error('401 unauthorized'); } })), /401 unauthorized/);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /status = 'blocked'/);
});

test('account cycles are serialized per venue and account', async () => {
  let active = 0, maximum = 0;
  const exchange = adapter({ listOpenOrders: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return []; } });
  setMockRunQuery(async () => []);
  const engine = new PositionReconciliationEngine();
  await Promise.all([engine.reconcileAccount(exchange), engine.reconcileAccount(exchange)]);
  assert.equal(maximum, 1);
});

test('account readiness remains isolated by exchange and account ID', async () => {
  setMockRunQuery(async (sql: string, params: any[] = []) => sql.includes('SELECT status, last_successful_at') ? (params[1] === 'acct-a' ? [{ status: 'ready', last_successful_at: Date.now() }] : [{ status: 'blocked', last_successful_at: Date.now() }]) : []);
  const engine = new PositionReconciliationEngine();
  assert.equal(await engine.getAccountReadiness({ exchange: 'binance', accountId: 'acct-a' }), true);
  assert.equal(await engine.getAccountReadiness({ exchange: 'binance', accountId: 'acct-b' }), false);
});

test('account readiness expires after the last successful snapshot becomes stale', async () => {
  setMockRunQuery(async (sql: string) => sql.includes('SELECT status, last_successful_at') ? [{ status: 'ready', last_successful_at: Date.now() - 91_000 }] : []);
  const engine = new PositionReconciliationEngine();
  assert.equal(await engine.getAccountReadiness({ exchange: 'binance', accountId: 'acct-a' }), false);
});
