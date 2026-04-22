import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../backend/main.js';
import { MarketDataService } from '../backend/api/marketDataService.js';
import { setMockRunQuery } from '../backend/database.js';
import { WebSocketServer } from 'ws';

setMockRunQuery(async (sql, _params, type) => {
  if (sql.includes('SELECT * FROM settings')) return [];
  if (sql.includes('SELECT 1')) return [{ 1: 1 }];
  if (sql.includes('SELECT * FROM balances')) {
    return [{ main_balance: 100000, bot_balance: 100000, active_trade_balance: 0, total_pnl: 0, total_pnl_pct: 0 }];
  }
  if (sql.includes('SELECT COUNT(*) as count')) return [{ count: 0 }];
  if (sql.includes('SELECT SUM(pnl) as totalPnl')) return [{ totalPnl: 0 }];
  if (sql.includes('SELECT exit_timestamp as time, pnl')) return [];
  if (type === 'all') return [];
  return { changes: 1 };
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

describe('End-to-End Trading Bot Tests', () => {
  test('App launch and strategy execution', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();
    
    assert.strictEqual(engine.isRunning, false);
    
    engine.runCycle = async () => {
      engine.stop();
    };

    // Start engine
    await engine.start();
    assert.strictEqual(engine.isRunning, false);
    
    wss.close();
  });

  test('Opening and closing trades with leverage', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();
    
    // Mock exchange and balance manager
    engine.exchange = {
      getCandles: async () => [{ time: Date.now(), open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 }],
      placeOrder: async () => ({ id: 'order123' }),
      apiKey: 'test-key'
    } as any;

    // Process a signal
    const signal = { symbol: 'BTC/USDT', side: 'buy', entryPrice: 50000, stopLoss: 49000, takeProfit: 52000, confidence: 90 };
    await engine.shadowTrader.processSignal(signal, 50000, 'moderate', engine.balanceManager, engine.exchange, 'strong_bull');
    
    assert.strictEqual(engine.shadowTrader.portfolios['moderate'].openTrades.length, 1);
    
    // Close trade
    const tradeId = engine.shadowTrader.portfolios['moderate'].openTrades[0].id;
    await engine.shadowTrader.closeTrade(tradeId, 51000, 'moderate', engine.balanceManager, engine.exchange);
    
    assert.strictEqual(engine.shadowTrader.portfolios['moderate'].openTrades.length, 0);
    
    engine.stop();
    wss.close();
  });
});
