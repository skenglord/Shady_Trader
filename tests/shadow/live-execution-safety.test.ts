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

  test('concurrent close requests submit only one live close order', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    setMockRunQuery(async () => ({ changes: 1 }));
    const trader = new ShadowTrader();
    const mode = RiskMode.ULTRA_CONSERVATIVE;
    trader.portfolios[mode].openTrades.push({
      id: 'live-close-1', symbol: 'BTC/USDT', side: 'buy', amount: 0.01,
      price: 50000, leverage: 1, exchangeOrderId: 'entry-order', stopLoss: 49000, takeProfit: 52000,
    });
    const releaseOrders: Array<(order: any) => void> = [];
    let orders = 0;
    const exchange = {
      hasExecutionCredentials: true,
      placeOrder: async () => {
        orders++;
        return new Promise(resolve => { releaseOrders.push(resolve); });
      },
    };
    const first = trader.closeTrade('live-close-1', 51000, mode, undefined, exchange);
    await new Promise(resolve => setImmediate(resolve));
    const second = trader.closeTrade('live-close-1', 51000, mode, undefined, exchange);
    await new Promise(resolve => setImmediate(resolve));
    for (const release of releaseOrders) release({ id: 'close-order', status: 'closed', filled: 0.01 });
    const results = await Promise.all([first, second]);
    assert.equal(orders, 1, 'only one close order may be submitted');
    assert.equal(results.filter(Boolean).length, 1, 'one close request should report success');
    assert.equal(trader.portfolios[mode].openTrades.length, 0);
  });

  test('uncertain live close remains claimed and is never automatically resubmitted', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    const claimed = new Set<string>();
    let orders = 0;
    setMockRunQuery(async (sql: string, params: any[] = []) => {
      if (sql.includes('INSERT INTO execution_intents')) {
        const key = String(params[0]);
        if (claimed.has(key)) return { changes: 0 };
        claimed.add(key);
      }
      return { changes: 1 };
    });
    const trader = new ShadowTrader();
    const mode = RiskMode.ULTRA_CONSERVATIVE;
    trader.portfolios[mode].openTrades.push({
      id: 'live-close-uncertain', symbol: 'BTC/USDT', side: 'buy', amount: 0.01,
      price: 50000, leverage: 1, exchangeOrderId: 'entry-order', stopLoss: 49000, takeProfit: 52000,
    });
    const exchange = {
      hasExecutionCredentials: true,
      placeOrder: async () => { orders++; throw new Error('timeout after possible fill'); },
    };
    assert.equal(await trader.closeTrade('live-close-uncertain', 49000, mode, undefined, exchange), false);
    assert.equal(await trader.closeTrade('live-close-uncertain', 49000, mode, undefined, exchange), false);
    assert.equal(orders, 1, 'uncertain result requires reconciliation before another exchange order');
    assert.equal(trader.portfolios[mode].openTrades.length, 1);
  });

  test('cancelled cycle does not submit an entry order', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    process.env.EXCHANGE_API_KEY = 'test-key';
    process.env.EXCHANGE_API_SECRET = 'test-secret';
    let insertedIntents = 0;
    let orders = 0;
    setMockRunQuery(async (sql: string) => {
      if (sql.includes('FROM execution_intents')) return [];
      if (sql.includes('SUM(pnl)')) return [{ netPnl: 0 }];
      if (sql.includes('INSERT INTO execution_intents')) insertedIntents++;
      return { changes: 1 };
    });
    const trader = new ShadowTrader();
    await trader.processSignal({
      symbol: 'BTC/USDT', side: 'buy', confidence: 99,
      entryPrice: 50000, stopLoss: 49000, takeProfit: 52000,
    }, 50000, RiskMode.ULTRA_CONSERVATIVE, undefined, {
      apiKey: 'test-key', apiSecret: 'test-secret',
      placeOrder: async () => { orders++; return { id: 'should-not-run', status: 'closed', filled: 1 }; },
    }, 'strongbull', 123456, () => true);
    assert.equal(insertedIntents, 0);
    assert.equal(orders, 0);
    assert.equal(trader.portfolios[RiskMode.ULTRA_CONSERVATIVE].openTrades.length, 0);
  });
});
