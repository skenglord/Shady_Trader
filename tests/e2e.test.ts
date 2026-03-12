import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../backend/main.js';
import { WebSocketServer } from 'ws';

describe('End-to-End Trading Bot Tests', () => {
  test('App launch and strategy execution', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    await engine.init();
    
    assert.strictEqual(engine.isRunning, false);
    
    // Start engine
    await engine.start();
    assert.strictEqual(engine.isRunning, true);
    
    // Stop engine
    engine.stop();
    assert.strictEqual(engine.isRunning, false);
    
    wss.close();
  });

  test('Opening and closing trades with leverage', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    await engine.init();
    
    // Mock exchange and balance manager
    engine.exchange = {
      getCandles: async () => [{ time: Date.now(), open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 }],
      placeOrder: async () => ({ id: 'order123' }),
      apiKey: 'test-key'
    } as any;
    
    // Start engine
    await engine.start();
    
    // Process a signal
    const signal = { symbol: 'BTC/USDT', side: 'buy', entryPrice: 50000, stopLoss: 49000, takeProfit: 52000 };
    await engine.shadowTrader.processSignal(signal, 50000, 'moderate', engine.balanceManager, engine.exchange);
    
    assert.strictEqual(engine.shadowTrader.portfolios['moderate'].openTrades.length, 1);
    
    // Close trade
    const tradeId = engine.shadowTrader.portfolios['moderate'].openTrades[0].id;
    await engine.shadowTrader.closeTrade(tradeId, 51000, 'moderate', engine.balanceManager, engine.exchange);
    
    assert.strictEqual(engine.shadowTrader.portfolios['moderate'].openTrades.length, 0);
    
    engine.stop();
    wss.close();
  });
});
