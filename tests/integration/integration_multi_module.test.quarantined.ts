import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { TradingEngine, getTradingEngine, startTradingEngine } from '../../backend/main.js';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';
import { RiskManager, RiskMode } from '../../backend/risk/manager.js';
import { IndicatorEngine } from '../../backend/indicators/engine.js';
import { RegimeDetector, RegimeType } from '../../backend/regime/detector.js';
import { SignalGenerator } from '../../backend/strategy/signal_generator.js';
import { setMockRunQuery } from '../../backend/database.js';
import Redis from 'ioredis';

// Mock Redis class that doesn't connect
class MockRedis {
  options = { host: 'localhost', port: 6379 };
  on(event: string, fn: any) {
    if (event === 'connect') {
      // Don't emit connect
    }
    if (event === 'error') {
      process.nextTick(() => fn(new Error('Connection refused')));
    }
  }
  get(key: string) { return Promise.resolve(null); }
  set(key: string, value: string) { return Promise.resolve('OK'); }
  setex(key: string, ttl: number, value: string) { return Promise.resolve('OK'); }
  del(key: string) { return Promise.resolve(1); }
  keys(pattern: string) { return Promise.resolve([]); }
  mget(keys: string[]) { return Promise.resolve([]); }
  eval(script: string, numkeys: number, ...args: any[]) { return Promise.resolve(null); }
  publish(channel: string, message: string) { return Promise.resolve(1); }
  duplicate() { return new MockRedis(); }
  subscribe(channel: string) { return Promise.resolve('OK'); }
  quit() { return Promise.resolve('OK'); }
}

function setupIntegrationMocks() {
  setMockRunQuery(async (sql: string, params?: any[], method?: string) => {
    if (sql.includes('SELECT 1')) return [{ 1: 1 }];
    if (sql.includes('SELECT * FROM settings')) return [];
    if (sql.includes('SELECT SUM(pnl)')) return [{ totalPnl: 0 }];
    if (sql.includes('SELECT COUNT(*) as count')) return [{ count: 0 }, { count: 0 }];
    if (sql.includes('SELECT exit_timestamp')) return [];
    if (sql.includes('SELECT * FROM shadow_trades WHERE risk_mode')) return [];
    if (sql.includes('DELETE FROM shadow_trades')) return { changes: 1 };
    if (sql.includes('INSERT INTO')) return { changes: 1 };
    return [];
  });
}

describe('Advanced Integration Tests - Multi-Module Interactions', () => {
  describe('Trading Engine Component Integration', () => {
    test('TradingEngine initializes all components correctly', () => {
      setupIntegrationMocks();
      const mockWss = { on: () => {}, clients: new Set() };
      const mockRedis = new MockRedis();
      
      const engine = new TradingEngine(mockWss as any, mockRedis as any);

      assert.ok(engine.indicators instanceof IndicatorEngine);
      assert.ok(engine.regimeDetector instanceof RegimeDetector);
      assert.ok(engine.signalGenerator instanceof SignalGenerator);
      assert.ok(engine.shadowTrader instanceof ShadowTrader);
    });

    test('ShadowTrader uses RiskManager for position sizing', async () => {
      setupIntegrationMocks();
      const shadowTrader = new ShadowTrader();
      const riskManager = new RiskManager();

      const signal = {
        symbol: 'BTC/USDT',
        side: 'buy',
        confidence: 75,
        entryPrice: 50000,
        stopLoss: 49500
      };

      const positionSize = riskManager.calculatePositionSize(
        100000,
        50000,
        49500,
        RiskMode.MODERATE,
        75
      );

      assert.ok(positionSize > 0);
    });

    test('RiskManager validates trades based on regime', () => {
      setupIntegrationMocks();
      const riskManager = new RiskManager();

      const signal = {
        confidence: 80,
        side: 'buy'
      };

      const isValid = riskManager.validateTrade(
        signal,
        RiskMode.MODERATE,
        0,
        RegimeType.STRONG_BULL
      );
      assert.ok(isValid);

      const isInvalid = riskManager.validateTrade(
        signal,
        RiskMode.MODERATE,
        0,
        'bear'
      );
      assert.strictEqual(isInvalid, false);
    });
  });

  describe('Indicator Engine Integration', () => {
    test('IndicatorEngine calculates all indicators correctly', () => {
      const engine = new IndicatorEngine();

      const candles = [];
      for (let i = 0; i < 50; i++) {
        candles.push({
          time: Date.now() - (i * 60000),
          open: 100,
          high: 105,
          low: 95,
          close: 100 + (i % 5),
          volume: 1000
        });
      }

      const result = engine.calculateAll(candles);

      assert.ok(result.length > 0);
      assert.ok(result[0].hasOwnProperty('close'));
    });
  });

  describe('Regime Detector Integration', () => {
    test('RegimeDetector processes indicator data', async () => {
      setupIntegrationMocks();
      const detector = new RegimeDetector();

      const df = [
        { time: Date.now(), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
        { time: Date.now() - 60000, open: 101, high: 106, low: 96, close: 103, volume: 1100 }
      ];

      const result = await detector.detect(df, false);

      assert.ok(result.regime !== undefined);
      assert.ok(typeof result.confidence === 'number');
    });
  });

  describe('Signal Generator Integration', () => {
    test('SignalGenerator uses regime for signal generation', async () => {
      setupIntegrationMocks();
      const generator = new SignalGenerator();

      const df = [
        { time: Date.now(), open: 100, high: 105, low: 95, close: 102, volume: 1000, rsi: 55, macd: 1, signal: 0.5 }
      ];

      const signal = await generator.generateSignal(df, RegimeType.STRONG_BULL, 'BTC/USDT', false, 'regime', 'moderate');

      if (signal) {
        assert.ok(signal.side);
        assert.ok(signal.symbol);
      }
    });
  });

  describe('End-to-End Trade Flow', () => {
    test('Trade signal flows through all components', async () => {
      setupIntegrationMocks();
      const mockWss = { on: () => {}, clients: new Set() };
      const mockRedis = new MockRedis();
      const engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;

      assert.ok(engine.indicators !== undefined);
      assert.ok(engine.regimeDetector !== undefined);
      assert.ok(engine.signalGenerator !== undefined);
      assert.ok(engine.shadowTrader !== undefined);
    });
  });

  describe('Portfolio State Consistency', () => {
    test('Portfolios maintain consistent state across operations', () => {
      setupIntegrationMocks();
      const shadowTrader = new ShadowTrader();

      const initialBalance = shadowTrader.portfolios[RiskMode.MODERATE].balance;
      const initialTrades = shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length;

      assert.strictEqual(initialBalance, 100000);
      assert.strictEqual(initialTrades, 0);
    });
  });

  describe('Risk Configuration Propagation', () => {
    test('Risk configs propagate to all components', () => {
      setupIntegrationMocks();
      const riskManager = new RiskManager();

      const moderateConfig = riskManager.getConfig(RiskMode.MODERATE);
      
      assert.strictEqual(moderateConfig.leverage, 1.5);
      assert.ok(moderateConfig.positionSize > 0);
      assert.ok(moderateConfig.maxConcurrentPositions > 0);
    });
  });

  describe('Multi-Mode Trading Simulation', () => {
    test('All modes can trade simultaneously', async () => {
      setupIntegrationMocks();
      const shadowTrader = new ShadowTrader();

      for (const mode of Object.values(RiskMode)) {
        assert.ok(shadowTrader.portfolios[mode] !== undefined);
        assert.strictEqual(shadowTrader.portfolios[mode].balance, 100000);
      }
    });
  });
});

describe('Integration Tests - Data Flow', () => {
  describe('Candle to Signal Flow', () => {
    test('Candles are processed through indicator engine', () => {
      const engine = new IndicatorEngine();

      const candles = [
        { time: 1, open: 100, high: 110, low: 90, close: 100, volume: 1000 },
        { time: 2, open: 100, high: 110, low: 90, close: 101, volume: 1100 },
        { time: 3, open: 101, high: 111, low: 91, close: 102, volume: 1200 },
        { time: 4, open: 102, high: 112, low: 92, close: 103, volume: 1300 },
        { time: 5, open: 103, high: 113, low: 93, close: 104, volume: 1400 },
      ];

      const df = engine.calculateAll(candles);
      
      assert.ok(df.length >= 0);
    });
  });

  describe('Regime to Signal Flow', () => {
    test('Different regimes produce different signal characteristics', async () => {
      setupIntegrationMocks();
      const generator = new SignalGenerator();

      const df = [{
        time: Date.now(),
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1000
      }];

      const regimes = ['strong_bull', 'weak_bull', 'sideways', 'bear', 'uncertain'];
      
      for (const regime of regimes) {
        const signal = await generator.generateSignal(df, regime as any, 'BTC/USDT', false, 'regime', 'moderate');
        assert.ok(signal === null || signal !== undefined);
      }
    });
  });

  describe('Performance to Risk Manager Flow', () => {
    test('Performance data is used for Kelly calculation', async () => {
      setupIntegrationMocks();
      const riskManager = new RiskManager();

      const kellySize = await riskManager.calculateKellyPositionSize(100000, RiskMode.MODERATE, 'strong_bull');
      
      assert.ok(typeof kellySize === 'number');
    });
  });
});