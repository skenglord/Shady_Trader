import { test, describe } from 'node:test';
import assert from 'node:assert';
import { RegimeDetector, RegimeType } from '../backend/regime/detector.js';
import { SignalGenerator } from '../backend/strategy/signal_generator.js';
import { RiskManager, RiskMode } from '../backend/risk/manager.js';
import { ShadowTrader } from '../backend/shadow/shadow_trader.js';
import { setMockRunQuery } from '../backend/database.js';

// Mock runQuery
setMockRunQuery(async (sql, params) => {
  if (sql.includes('SELECT COUNT(*) as count')) return [{ count: 0 }];
  if (sql.includes('SELECT SUM(pnl) as totalPnl')) return [{ totalPnl: 0 }];
  if (sql.includes('SELECT COUNT(*) as count') && sql.includes('pnl > 0')) return [{ count: 0 }];
  if (sql.includes('SELECT exit_timestamp as time, pnl')) return [];
  return [];
});

describe('Trading System Tests', () => {
  test('RegimeDetector should classify strong bull regime correctly', async () => {
    const detector = new RegimeDetector();
    const mockDf = Array(100).fill(0).map((_, i) => ({
      close: 100 + i, // Price goes up
      adx: 35,
      volume_ratio: 1.5,
      rsi_14: 60
    }));
    
    const result = await detector.detect(mockDf);
    assert.strictEqual(result.regime, RegimeType.STRONG_BULL);
    assert.ok(result.confidence > 90);
  });

  test('RegimeDetector should classify bear regime correctly', async () => {
    const detector = new RegimeDetector();
    const mockDf = Array(100).fill(0).map((_, i) => ({
      close: 100 - i, // Price goes down
      adx: 25,
      volume_ratio: 1.0,
      rsi_14: 30
    }));
    
    const result = await detector.detect(mockDf);
    assert.strictEqual(result.regime, RegimeType.BEAR);
    assert.ok(result.confidence > 80);
  });

  test('SignalGenerator should generate buy signal in strong bull regime', async () => {
    const generator = new SignalGenerator();
    const mockDf = Array(50).fill(0).map((_, i) => ({
      close: 100 + i,
      low: 99 + i,
      ema_21: 100 + i,
      ema_50: 95 + i,
      rsi_14: 55
    }));
    
    // Make the last candle bounce off EMA 21
    mockDf[48].low = 147; // prev low <= prev ema_21 (148)
    mockDf[49].close = 150; // last close > last ema_21 (149)
    
    const signal = await generator.generateSignal(mockDf, RegimeType.STRONG_BULL, 'BTC/USDT');
    assert.ok(signal);
    assert.strictEqual(signal?.side, 'buy');
    assert.strictEqual(signal?.symbol, 'BTC/USDT');
  });

  test('RiskManager should calculate position size with leverage correctly', () => {
    const manager = new RiskManager();
    // Override config for test
    manager.RISK_CONFIGS[RiskMode.MODERATE] = {
      maxRiskPerTrade: 0.02, // 2%
      leverage: 10
    };
    
    const balance = 10000;
    const entryPrice = 100;
    const stopLoss = 90; // Risk per unit = 10
    
    // Risk amount = 10000 * 0.02 = 200
    // Risk based size = 200 / 10 = 20 units
    // Max leveraged size = (10000 * 10) / 100 = 1000 units
    // Should return min(20, 1000) = 20
    const size = manager.calculatePositionSize(balance, entryPrice, stopLoss, RiskMode.MODERATE);
    assert.strictEqual(size, 20);
    
    // Test leverage constraint
    const tightStopLoss = 99.9; // Risk per unit = 0.1
    // Risk based size = 200 / 0.1 = 2000 units
    // Max leveraged size = 1000 units
    // Should return min(2000, 1000) = 1000
    const sizeLeveraged = manager.calculatePositionSize(balance, entryPrice, tightStopLoss, RiskMode.MODERATE);
    assert.strictEqual(sizeLeveraged, 1000);
  });

  test('ShadowTrader reset should clear trades and set balance to 100,000', async () => {
    const trader = new ShadowTrader();
    // Simulate some trades
    trader.portfolios[RiskMode.MODERATE].balance = 150000;
    trader.portfolios[RiskMode.MODERATE].openTrades = [{ id: 'test' }];
    
    await trader.reset();
    
    assert.strictEqual(trader.portfolios[RiskMode.MODERATE].balance, 100000);
    assert.strictEqual(trader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
  });

  test('ShadowTrader getPerformance should include history', async () => {
    const trader = new ShadowTrader();
    const perf = await trader.getPerformance();
    
    assert.ok(perf[RiskMode.MODERATE].history);
    assert.ok(Array.isArray(perf[RiskMode.MODERATE].history));
    assert.ok(perf[RiskMode.MODERATE].history.length >= 1);
  });

  test('ShadowTrader updatePositions should apply trailing stops', async () => {
    const trader = new ShadowTrader();
    const mode = RiskMode.MODERATE;
    trader.portfolios[mode].balance = 10000;
    
    // Mock a buy trade
    const trade = {
      id: 'test-trail',
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 1,
      price: 100, // Entry price
      status: 'open',
      timestamp: Date.now(),
      risk_mode: mode,
      stopLoss: 90,
      takeProfit: 120,
      leverage: 1
    };
    trader.portfolios[mode].openTrades = [trade];
    
    // Price goes up by 2%
    await trader.updatePositions(102, mode, null, null);
    
    // Trailing stop should be 102 * 0.99 = 100.98
    // Which is > 90, so it should update
    assert.strictEqual(trader.portfolios[mode].openTrades.length, 1);
    assert.strictEqual(trader.portfolios[mode].openTrades[0].stopLoss, 100.98);
  });

  test('ShadowTrader updatePositions should trigger liquidation', async () => {
    const trader = new ShadowTrader();
    const mode = RiskMode.DEGEN; // Leverage 100x
    trader.riskManager.RISK_CONFIGS[mode].leverage = 100;
    trader.portfolios[mode].balance = 10000;
    
    // Mock a buy trade
    const trade = {
      id: 'test-liq',
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 1,
      price: 100, // Entry price
      status: 'open',
      timestamp: Date.now(),
      risk_mode: mode,
      stopLoss: 90,
      takeProfit: 120,
      leverage: 100
    };
    trader.portfolios[mode].openTrades = [trade];
    
    // Price drops by 1% (100 -> 99)
    // Loss is 1%. Max loss allowed is (1/100) - 0.005 = 0.01 - 0.005 = 0.005 (0.5%)
    // So 1% loss should trigger liquidation
    await trader.updatePositions(99, mode, null, null);
    
    assert.strictEqual(trader.portfolios[mode].openTrades.length, 0); // Trade closed
    // PnL should be total loss of margin: -amount * price * (1/leverage) = -1 * 100 * 0.01 = -1
    // Wait, initial balance was 10000, so new balance is 9999
    assert.strictEqual(trader.portfolios[mode].balance, 9999);
  });

  test('SignalGenerator should generate Shotgun signal', async () => {
    const generator = new SignalGenerator();
    const df = Array(100).fill({ rsi_14: 60, close: 100 });
    const signal = await generator.generateSignal(df, RegimeType.STRONG_BULL, 'BTC/USDT', false, 'shotgun');
    assert.ok(signal);
    assert.strictEqual(signal.side, 'buy');
    assert.strictEqual(signal.reasoning, 'Shotgun: Triggered by RSI');
  });

  test('SignalGenerator should generate Alt Chaser signal', async () => {
    const generator = new SignalGenerator();
    const df = Array(100).fill({ rsi_14: 60, close: 100 });
    df[98] = { close: 100 };
    df[99] = { close: 102 }; // 2% increase
    const signal = await generator.generateSignal(df, RegimeType.STRONG_BULL, 'BTC/USDT', false, 'alt_chaser');
    assert.ok(signal);
    assert.strictEqual(signal.side, 'buy');
    assert.strictEqual(signal.reasoning, 'Alt Chaser: Price change > 1%');
  });

  test('SignalGenerator should generate Chasing Dragons signal', async () => {
    const generator = new SignalGenerator();
    const df = Array(100).fill({ rsi_14: 60, close: 100 });
    const signal = await generator.generateSignal(df, RegimeType.STRONG_BULL, 'BTC/USDT', false, 'chasing_dragons');
    assert.ok(signal);
    assert.strictEqual(signal.side, 'buy');
    assert.strictEqual(signal.reasoning, 'Chasing Dragons: Probability score maintained');
  });

  test('ShadowTrader should close trade on stop loss', async () => {
    const trader = new ShadowTrader();
    const mode = RiskMode.MODERATE;
    trader.portfolios[mode].balance = 10000;
    const trade = {
      id: 'test-trade',
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 1,
      price: 100,
      status: 'open',
      timestamp: Date.now(),
      risk_mode: mode,
      stopLoss: 90,
      takeProfit: 110,
      leverage: 1
    };
    trader.portfolios[mode].openTrades.push(trade);
    
    // Price drops to 89, should close
    await trader.updatePositions(89, mode, null, null);
    
    assert.strictEqual(trader.portfolios[mode].openTrades.length, 0);
    // PnL = (89 - 100) * 1 = -11
    assert.strictEqual(trader.portfolios[mode].balance, 10000 - 11);
  });
});
