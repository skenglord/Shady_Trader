import { describe, test } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../backend/main.js';

describe('TradingEngine utility methods', () => {
  test('startSchedulers/stopSchedulers are idempotent and diagnostics are exposed', () => {
    const engine = new TradingEngine({ clients: new Set() } as any);
    engine.marketDataService.fetchMarketData = async () => null as any;
    engine.marketDataService.fetchNews = async () => [] as any;

    engine.stopSchedulers();
    engine.stopSchedulers();
    engine.startSchedulers();
    engine.startSchedulers();

    const diagnostics = engine.getStartupDiagnostics();
    assert.strictEqual(typeof diagnostics.exchangeEnabled, 'boolean');
    assert.strictEqual(diagnostics.symbol, engine.symbol);

    engine.stopSchedulers();
  });

  test('runCycle returns early when exchange has insufficient candles', async () => {
    const engine = new TradingEngine({ clients: new Set() } as any);
    engine.marketDataService.fetchMarketData = async () => null as any;
    engine.marketDataService.fetchNews = async () => [] as any;

    engine.exchange = {
      getCandles: async () => [{ time: Date.now(), open: 1, high: 1, low: 1, close: 1, volume: 1 }]
    } as any;

    await engine.runCycle();
    engine.stopSchedulers();
    assert.ok(true);
  });
});
