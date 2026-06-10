import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../../backend/main.js';
import { setMockRunQuery, clearMockRunQuery } from '../../backend/database.js';
import Redis from 'ioredis';

// Mock Redis class that doesn't connect
class MockRedis {
  options = { host: 'localhost', port: 6379 };
  on(event: string, fn: any) {
    if (event === 'connect') {
      // Don't emit connect - simulate unavailable Redis
    }
    if (event === 'error') {
      // Simulate connection error
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

// Override Redis default export globally for this test file
const originalRedis = Redis;
MockRedis.prototype.constructor = Redis;

// Mock database queries
function setupMocks() {
  setMockRunQuery(async (sql: string, params?: any[], method?: string) => {
    if (sql.includes('SELECT 1')) return [{ 1: 1 }];
    if (sql.includes('SELECT * FROM settings')) return [];
    if (sql.includes('SELECT SUM(pnl)')) return [{ totalPnl: 0 }];
    if (sql.includes('SELECT COUNT(*)')) return [{ count: 0 }, { count: 0 }];
    if (sql.includes('SELECT exit_timestamp as time, pnl')) return [];
    if (sql.includes('SELECT * FROM shadow_trades WHERE risk_mode')) return [];
    if (sql.includes('SELECT * FROM balances WHERE id = ?')) return [{
      id: 'default',
      main_balance: 100000,
      bot_balance: 50000,
      active_trade_balance: 0,
      total_pnl: 0,
      total_pnl_pct: 0
    }];
    if (sql.includes('INSERT INTO')) return { changes: 1 };
    if (sql.includes('INSERT INTO audit_trades')) return { changes: 1 };
    if (sql.includes('INSERT INTO audit_system_events')) return { changes: 1 };
    if (sql.includes('INSERT INTO regime_history')) return { changes: 1 };
    if (sql.includes('UPDATE shadow_trades')) return { changes: 1 };
    if (sql.includes('UPDATE balances')) return { changes: 1 };
    if (sql.includes('UPDATE OR REPLACE INTO settings')) return { changes: 1 };
    if (sql.includes('DELETE FROM shadow_trades')) return { changes: 1 };
    return [];
  });
}

describe('Deep Deterministic Tests - TradingEngine (main.ts)', { concurrency: false }, () => {
  let engine: TradingEngine;
  let mockWss: any;
  let mockRedis: MockRedis;

  beforeEach(() => {
    setupMocks();
    mockRedis = new MockRedis();
    mockWss = {
      on: () => {},
      clients: new Set()
    };
  });

  afterEach(async () => {
    if (engine && typeof engine.stopSchedulers === 'function') {
      await engine.stopSchedulers();
    }
    // CRITICAL: reset the global DB mock so it doesn't leak into other test
    // files running concurrently in the same process. We set it to a no-op
    // stub (not null) so any *post-test* async work that calls runQuery
    // (e.g. a setInterval scheduled inside runCycle that fires after the
    // test has ended) does not throw "Database not initialized" and
    // pollute the failure summary with a spurious error.
    setMockRunQuery(async () => []);
    // The nested Edge Cases describe owns final clearMockRunQuery() in its own
    // afterEach hook so this delayed clear cannot race with that test's
    // custom SELECT 1 retry mock.
  });

  describe('Constructor and Initialization', () => {
    test('TradingEngine initializes with default state', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.isRunning, false);
      assert.strictEqual(engine.symbol, 'BTC/USDT');
      assert.strictEqual(engine.timeframe, '15m');
      assert.strictEqual(engine.activeMode, 'moderate');
    });

    test('TradingEngine has all required component instances', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.ok(engine.indicators !== undefined);
      assert.ok(engine.regimeDetector !== undefined);
      assert.ok(engine.signalGenerator !== undefined);
      assert.ok(engine.shadowTrader !== undefined);
      assert.ok(engine.balanceManager !== undefined);
      assert.ok(engine.marketDataService !== undefined);
      assert.ok(engine.optimizationEngine !== undefined);
      assert.ok(engine.monteCarloEngine !== undefined);
    });

    test('TradingEngine has paper trading components', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.ok(engine.paperTradingService !== undefined);
      assert.ok(engine.paperTradingWebSocketHandler !== undefined);
    });
  });

  describe('State Property Getters/Setters with Redis Backing', () => {
    test('currentRegime getter returns default value', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.ok(['strong_bull', 'weak_bull', 'sideways', 'bear', 'uncertain'].includes(engine.currentRegime));
    });

    test('manualRegime getter returns null by default', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.manualRegime, null);
    });

    test('isRunning getter returns false initially', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.isRunning, false);
    });

    test('symbol getter returns BTC/USDT by default', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.symbol, 'BTC/USDT');
    });

    test('timeframe getter returns 15m by default', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.timeframe, '15m');
    });

    test('activeMode getter returns moderate by default', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.activeMode, 'moderate');
    });

    test('strategy getter returns regime by default', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.strategy, 'regime');
    });

    test('aiStrategySwitching getter returns false initially', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      assert.strictEqual(engine.aiStrategySwitching, false);
    });
  });

  describe('Startup Diagnostics', () => {
    test('getStartupDiagnostics returns expected structure', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      const diagnostics = engine.getStartupDiagnostics();
      
      assert.ok(diagnostics !== null);
      assert.strictEqual(typeof diagnostics.exchangeEnabled, 'boolean');
      assert.strictEqual(typeof diagnostics.exchangeName, 'string');
      assert.strictEqual(typeof diagnostics.exchangeConfigured, 'boolean');
      assert.strictEqual(typeof diagnostics.isRunning, 'boolean');
      assert.strictEqual(typeof diagnostics.symbol, 'string');
      assert.strictEqual(typeof diagnostics.timeframe, 'string');
    });

    test('getStartupDiagnostics reflects exchange disabled state', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      await engine.init();

      const diagnostics = engine.getStartupDiagnostics();

      assert.strictEqual(diagnostics.exchangeEnabled, false);
      assert.strictEqual(diagnostics.hasExchangeInstance, false);
    });
  });

  describe('Sleep Methods', () => {
    test('sleepWithTimeout resolves after specified milliseconds', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      const start = Date.now();
      await (engine as any).sleepWithTimeout(10, 100);
      const elapsed = Date.now() - start;
      
      assert.ok(elapsed >= 10);
      assert.ok(elapsed < 50);
    });

    test('sleepWithTimeout rejects on timeout', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      let errorThrown = false;
      try {
        await (engine as any).sleepWithTimeout(100, 10);
      } catch (e: any) {
        errorThrown = true;
        assert.ok(e.message.includes('Sleep timeout'));
      }
      assert.ok(errorThrown);
    });
  });

  describe('Broadcast Method', () => {
    test('broadcast sends JSON messages to WebSocket clients', () => {
      const sentMessages: string[] = [];
      const mockClient = {
        readyState: 1,
        send: (msg: string) => { sentMessages.push(msg); }
      };
      
      mockWss.clients = new Set([mockClient]);
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      const testMessage = { type: 'test', data: { value: 42 } };
      engine.broadcast(testMessage);
      
      assert.strictEqual(sentMessages.length, 1);
      const parsed = JSON.parse(sentMessages[0]);
      assert.strictEqual(parsed.type, 'test');
      assert.strictEqual(parsed.data.value, 42);
    });

    test('broadcast skips clients that are not open', () => {
      const sentMessages: string[] = [];
      const closedClient = {
        readyState: 3,
        send: (msg: string) => { sentMessages.push(msg); }
      };
      const openClient = {
        readyState: 1,
        send: (msg: string) => { sentMessages.push(msg); }
      };
      
      mockWss.clients = new Set([closedClient, openClient]);
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      engine.broadcast({ type: 'test' });
      
      assert.strictEqual(sentMessages.length, 1);
    });
  });

  describe('Stop Method', () => {
    test('stop sets isRunning to false', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      engine.isRunning = true;
      
      engine.stop();
      
      assert.strictEqual(engine.isRunning, false);
    });

    test('stop calls stopSchedulers', () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      let stopSchedulersCalled = false;
      (engine as any).stopSchedulers = async () => { stopSchedulersCalled = true; };
      
      engine.stop();
      
      assert.ok(stopSchedulersCalled);
    });
  });

  describe('Run Cycle Methods', () => {
    test('runCycle returns early when exchange has insufficient candles', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      engine.exchange = {
        getCandles: async () => [{ time: Date.now(), open: 1, high: 1, low: 1, close: 1, volume: 1 }]
      } as any;
      
      await engine.runCycle();
      assert.ok(true);
    });

    test('runCycle returns immediately when engine is stopped', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      engine.isRunning = false;
      let exchangeCalled = false;
      engine.exchange = {
        getCandles: async () => {
          exchangeCalled = true;
          throw new Error('runCycle should not call exchange after stop');
        }
      } as any;

      await engine.runCycle();
      assert.strictEqual(exchangeCalled, false);
    });

    test('stop clears the current cycle sleep timer', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      engine.isRunning = true;

      const sleepPromise = (engine as any).sleepWithTimeout(5000, 10000);
      engine.stop();

      await sleepPromise;
      assert.strictEqual(engine.isRunning, false);
    });

    test('setTimeframe awaits runCycle when engine is running', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      engine.isRunning = true;
      let runCycleCalls = 0;
      engine.runCycle = async () => {
        runCycleCalls++;
      };

      await engine.setTimeframe('1h');
      assert.strictEqual(engine.timeframe, '1h');
      assert.strictEqual(runCycleCalls, 1);
    });

    test('runCycle processes when exchange has sufficient candles', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      const candles = [];
      for (let i = 0; i < 150; i++) {
        candles.push({
          time: Date.now() - (i * 60000),
          open: 100 + Math.random() * 10,
          high: 100 + Math.random() * 10,
          low: 100 - Math.random() * 10,
          close: 100 + Math.random() * 10,
          volume: 1000
        });
      }
      
      engine.exchange = {
        getCandles: async () => candles
      } as any;
      
      await engine.runCycle();
      assert.ok(true);
    });
  });

  describe('Run Backtest', () => {
    test('runBacktest returns empty result with insufficient candles', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      const result = await engine.runBacktest('moderate');
      
      assert.strictEqual(result.trades.length, 0);
      assert.strictEqual(result.candles.length, 0);
    });

    test('runBacktest processes candles with sufficient data', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      const candles = [];
      for (let i = 0; i < 150; i++) {
        candles.push({
          time: Date.now() - (i * 60000),
          open: 100,
          high: 101,
          low: 99,
          close: 100 + (i % 5),
          volume: 1000
        });
      }
      
      engine.exchange = {
        getCandles: async () => candles
      } as any;
      engine.indicators.calculateAll = (candles: any[]) => {
        return candles.map((c, i) => ({
          ...c,
          rsi: 50,
          macd: 0,
          signal: 0
        }));
      };
      engine.regimeDetector.detect = async () => ({
        regime: 'strong_bull',
        confidence: 80,
        reasoning: 'test',
        metrics: {},
        timestamp: Date.now()
      } as any);
      engine.regimeDetector.shouldUpdateRegime = () => true;
      engine.signalGenerator.generateSignal = async () => null;
      
      const result = await engine.runBacktest('moderate');
      
      assert.ok(result.candles.length >= 100);
    });
  });

  describe('Timeframe Changes', () => {
    test('setTimeframe updates the timeframe property', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      
      await engine.setTimeframe('1h');
      
      assert.strictEqual(engine.timeframe, '1h');
    });
  });

  describe('Kill Bot', () => {
    test('killBot handles missing exchange gracefully', async () => {
      engine = new TradingEngine(mockWss as any, mockRedis as any);
      engine.isExchangeEnabled = false;
      engine.isRunning = false;
      
      await engine.killBot();
      assert.ok(true);
    });
  });
});

describe('TradingEngine Methods - Edge Cases', { concurrency: false }, () => {
  let engine: TradingEngine;
  let mockWss: any;
  let mockRedis: MockRedis;

  beforeEach(() => {
    setupMocks();
    mockRedis = new MockRedis();
    mockWss = {
      on: () => {},
      clients: new Set()
    };
  });

  afterEach(async () => {
    if (engine && typeof engine.stopSchedulers === 'function') {
      await engine.stopSchedulers();
    }
    // CRITICAL: reset the global DB mock so it doesn't leak into other test
    // files running concurrently in the same process. We set it to a no-op
    // stub (not null) so any *post-test* async work that calls runQuery
    // (e.g. a setInterval scheduled inside runCycle that fires after the
    // test has ended) does not throw "Database not initialized" and
    // pollute the failure summary with a spurious error.
    setMockRunQuery(async () => []);
    // Schedule the actual clear on a later tick so any pending callbacks
    // that fire in the same tick can still resolve cleanly.
    setTimeout(() => clearMockRunQuery(), 20);
  });

  test('init retries database connection on failure', async () => {
    let callCount = 0;
    setMockRunQuery(async (sql: string) => {
      if (sql.includes('SELECT 1')) {
        callCount++;
        if (callCount < 3) throw new Error('DB not ready');
        return [{ 1: 1 }];
      }
      return [];
    });

    engine = new TradingEngine(mockWss as any, mockRedis as any);
    engine.isExchangeEnabled = false;
    await engine.init();
    
    assert.ok(callCount >= 3, `expected at least 3 SELECT 1 attempts, got ${callCount}`);
  });

  test('backupDatabase handles missing database file', async () => {
    engine = new TradingEngine(mockWss as any, mockRedis as any);
    engine.isExchangeEnabled = false;
    
    engine.backupDatabase();
    assert.ok(true);
  });

  test('loadSettings handles missing database gracefully', async () => {
    engine = new TradingEngine(mockWss as any, mockRedis as any);
    engine.isExchangeEnabled = false;
    
    await engine.loadSettings();
    assert.ok(true);
  });

  test('runMonteCarloSimulation accepts valid input', async () => {
    engine = new TradingEngine(mockWss as any, mockRedis as any);
    engine.isExchangeEnabled = false;
    
    const result = await engine.runMonteCarloSimulation(
      { initialBalance: 100000, positions: [] },
      { iterations: 100 }
    );
    
    assert.ok(result !== undefined);
  });

  test('runMonteCarloStressTest accepts valid input', async () => {
    engine = new TradingEngine(mockWss as any, mockRedis as any);
    engine.isExchangeEnabled = false;
    
    const result = await engine.runMonteCarloStressTest(
      { initialBalance: 100000, positions: [] },
      [{ type: 'market', magnitude: 0.1 }]
    );
    
    assert.ok(result !== undefined);
  });
});