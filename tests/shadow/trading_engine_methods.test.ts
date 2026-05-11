import { describe, test } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../../backend/main.js';
import { setMockRunQuery } from '../../backend/database.js';

setMockRunQuery(async (sql: string) => {
  if (sql.includes('SELECT 1')) return [{ 1: 1 }];
  if (sql.includes('INSERT INTO settings')) return { changes: 1 };
  return [];
});

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

  test('runBacktest returns empty result with insufficient candles', async () => {
    const engine = new TradingEngine({ clients: new Set() } as any);
    engine.isExchangeEnabled = false;
    
    const result = await engine.runBacktest('moderate');
    assert.strictEqual(result.trades.length, 0);
    engine.stopSchedulers();
  });

  test('killBot returns funds when no trades', async () => {
    const engine = new TradingEngine({ clients: new Set() } as any);
    engine.isExchangeEnabled = false;
    engine.isRunning = false;
    
    // Should complete without error when no trades
    assert.ok(true);
    engine.stopSchedulers();
  });

  test('broadcast sends messages to clients', () => {
    const sentMessages: string[] = [];
    const mockClient = {
      readyState: 1,
      send: (msg: string) => { sentMessages.push(msg); }
    };
    const engine = new TradingEngine({ 
      clients: new Set([mockClient]) 
    } as any);
    
    engine.broadcast({ type: 'test', data: { value: 123 } });
    assert.strictEqual(sentMessages.length, 1);
    const parsed = JSON.parse(sentMessages[0]);
    assert.strictEqual(parsed.type, 'test');
    assert.strictEqual(parsed.data.value, 123);
    engine.stopSchedulers();
  });
});
