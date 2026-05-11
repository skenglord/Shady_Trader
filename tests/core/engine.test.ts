import { test } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../../backend/main.ts';
import { MarketDataService } from '../../backend/api/marketDataService.ts';
import { setMockRunQuery } from '../../backend/database.ts';
import { WebSocketServer } from 'ws';

setMockRunQuery(async (sql) => {
  if (sql.includes('SELECT * FROM settings')) return [];
  if (sql.includes('SELECT 1')) return [{ 1: 1 }];
  return [];
});

MarketDataService.prototype.fetchMarketData = async () => ({
  market_cap: 0,
  total_volume: 0,
  fear_greed_index: 50,
  fear_greed_value: 'Neutral',
  btc_dominance: 0,
  last_updated: Date.now(),
  timestamp: Date.now()
});
MarketDataService.prototype.fetchNews = async () => ([]);

test('TradingEngine should initialize with correct polling interval', async () => {
  const wss = new WebSocketServer({ noServer: true });
  const redisMock: any = {
    options: { host: 'mock', port: 6379 },
    on: () => undefined,
    get: async () => null,
    set: async () => 'OK',
    setex: async () => 'OK',
    del: async () => 1,
    keys: async () => [],
    mget: async () => [],
    eval: async () => 'OK',
    publish: async () => 1,
    duplicate: () => ({ subscribe: async () => undefined, on: () => undefined })
  };
  const engine = new TradingEngine(wss, redisMock);
  engine.isExchangeEnabled = false;
  await engine.init();
  assert.strictEqual(engine.isRunning, false);
  wss.close();
});
