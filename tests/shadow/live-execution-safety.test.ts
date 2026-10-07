import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMockRunQuery, setMockRunQuery } from '../../backend/database.js';
import { RiskMode } from '../../backend/risk/manager.js';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';

describe('live execution safeguards', () => {
  const previous = {
    enabled: process.env.LIVE_TRADING_ENABLED,
    key: process.env.EXCHANGE_API_KEY,
    secret: process.env.EXCHANGE_API_SECRET,
    degen: process.env.DEGEN_LIVE_OVERRIDE,
  };

  afterEach(() => {
    if (previous.enabled === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = previous.enabled;
    if (previous.key === undefined) delete process.env.EXCHANGE_API_KEY;
    else process.env.EXCHANGE_API_KEY = previous.key;
    if (previous.secret === undefined) delete process.env.EXCHANGE_API_SECRET;
    else process.env.EXCHANGE_API_SECRET = previous.secret;
    if (previous.degen === undefined) delete process.env.DEGEN_LIVE_OVERRIDE;
    else process.env.DEGEN_LIVE_OVERRIDE = previous.degen;
    clearMockRunQuery();
  });

  test('uncertain live order is persisted and blocks retry for the same mode', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    process.env.EXCHANGE_API_KEY = 'test-key';
    process.env.EXCHANGE_API_SECRET = 'test-secret';
    const claimed = new Set<string>();
    const unresolvedModes = new Set<string>();
    const insertedShadowTrades: any[][] = [];
    let orders = 0;

    setMockRunQuery(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM execution_intents')) {
        return unresolvedModes.size > 0 ? [{ idempotency_key: 'pending' }] : [];
      }
      if (sql.includes('FROM shadow_trades') && sql.includes("status = 'open'")) return [];
      if (sql.includes('SUM(pnl)')) return [{ netPnl: 0 }];
      if (sql.includes('INSERT INTO execution_intents')) {
        const key = String(params[0]);
        if (claimed.has(key)) return { changes: 0 };
        claimed.add(key);
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO shadow_trades')) {
        insertedShadowTrades.push(params);
        return { changes: 1 };
      }
      if (sql.includes("status = 'uncertain'")) {
        unresolvedModes.add('ultra_conservative');
        return { changes: 1 };
      }
      return { changes: 1 };
    });

    const trader = new ShadowTrader();
    const signal = {
      symbol: 'BTC/USDT', side: 'buy', confidence: 99,
      entryPrice: 50000, stopLoss: 49000, takeProfit: 52000,
    };
    const exchange = {
      apiKey: 'test-key', apiSecret: 'test-secret',
      placeOrder: async () => { orders++; throw new Error('simulated timeout'); },
    };

    await trader.processSignal(signal, 50000, RiskMode.ULTRA_CONSERVATIVE, undefined, exchange, 'strongbull', 123456);
    assert.equal(orders, 1);
    assert.equal(trader.portfolios[RiskMode.ULTRA_CONSERVATIVE].openTrades.length, 0);
    const pendingTrade = insertedShadowTrades.find(row => row[7] === RiskMode.ULTRA_CONSERVATIVE);
    assert.ok(pendingTrade, 'pending trade intent is persisted before order submission');
    assert.equal(pendingTrade[5], 'pending');

    await trader.processSignal(signal, 50000, RiskMode.ULTRA_CONSERVATIVE, undefined, exchange, 'strongbull', 123456);
    assert.equal(orders, 1, 'unresolved order outcome blocks duplicate retry');
  });
});
