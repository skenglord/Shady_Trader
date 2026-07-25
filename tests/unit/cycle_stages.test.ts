import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../backend/main.js';
import { RegimeType } from '../../backend/regime/detector.js';
import { setMockRunQuery, clearMockRunQuery } from '../../backend/database.js';

// ---------------------------------------------------------------------------
// Helpers — stubbed collaborators + CycleContext factory
// ---------------------------------------------------------------------------

function fakeRedis() {
  const redis = {
    status: 'ready',
    options: { host: 'memory', port: 0 },
    on: () => redis,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    keys: async () => [],
    mget: async () => [],
    eval: async () => 0,
    duplicate: () => redis,
  };
  return redis;
}

function fakeWss() {
  const wss = { clients: new Set(), on: () => wss };
  return wss;
}

function makeCandles(count: number, base = 100): any[] {
  return Array.from({ length: count }, (_, i) => {
    const p = base + i * 0.1;
    return {
      time: i * 60000,
      open: p,
      high: p + 0.05,
      low: p - 0.05,
      close: p,
      volume: 1000,
    };
  });
}

/**
 * Build a minimal CycleContext matching the interface in main.ts.
 */
function makeCtx(overrides: Partial<any> = {}): any {
  return {
    cycleToken: 0,
    symbol: 'BTC/USDT',
    timeframe: '15m',
    strategy: 'regime',
    activeMode: 'moderate',
    currentRegime: RegimeType.UNCERTAIN,
    manualRegime: null,
    aiSignalGeneration: false,
    aiSentimentAnalysis: false,
    aiStrategySwitching: false,
    redisClient: undefined,
    ...overrides,
  };
}

/**
 * Create a TradingEngine with all collaborators stubbed so no network/DB
 * calls happen. Each test can override specific stubs.
 */
function createEngine(stubs: Partial<{
  candles: any[];
  regimeResult: any;
  signal: any;
  liveConfidence: any;
  shouldUpdateRegime: boolean;
  broadcastSink: any[];
}> = {}): { engine: TradingEngine; messages: any[] } {
  const messages: any[] = [];
  const wss = fakeWss();
  const engine = new TradingEngine(wss as any, fakeRedis() as any);

  // Override broadcast to capture messages
  (engine as any).broadcast = (msg: any) => {
    messages.push(msg);
    // Also deliver to any fake clients
    wss.clients.forEach((c: any) => {
      if (c.readyState === 1 && c.authed) c.send(JSON.stringify(msg));
    });
  };

  // Stub exchange
  engine.exchange = {
    getCandles: async () => stubs.candles ?? makeCandles(50),
    setActiveSymbol: () => {},
    shutdown: () => {},
    exchangeName: 'mock',
    apiKey: undefined,
  } as any;

  // Stub indicators
  engine.indicators.calculateAll = (rows: any[]) => rows.map((r) => ({
    ...r,
    ema_9: r.close,
    ema_21: r.close,
    ema_50: r.close,
    rsi_14: 50,
    bb_upper: r.close * 1.02,
    bb_lower: r.close * 0.98,
    adx_14: 25,
  }));

  // Stub regime detector
  (engine.regimeDetector as any).detect = async () =>
    stubs.regimeResult ?? {
      regime: RegimeType.UNCERTAIN,
      confidence: 50,
      reasoning: 'mock',
      metrics: {},
      timestamp: Date.now(),
    };
  (engine.regimeDetector as any).shouldUpdateRegime = () => stubs.shouldUpdateRegime ?? false;

  // Stub signal generator
  (engine.signalGenerator as any).generateSignal = async () => stubs.signal ?? null;
  (engine.signalGenerator as any).computeLiveConfidence = () =>
    stubs.liveConfidence ?? { score: 42, side: 'neutral', indicators: ['mock'], distances: {} };

  // Stub market data service
  (engine.marketDataService as any).getLatestMarketData = async () => ({
    btc_dominance: 50,
    fear_greed_index: 'neutral',
  });
  (engine.marketDataService as any).getLatestNews = async () => [];

  // Stub shadow trader getPerformance (called in detectRegimeStage + broadcastCycleStage)
  (engine.shadowTrader as any).getPerformance = async () => ({});
  (engine.shadowTrader as any).getPerformance = () => ({});

  // Stub balance manager
  (engine.balanceManager as any).getBalances = async () => ({
    mainBalance: 100000,
    botBalance: 5000,
    activeTradeBalance: 0,
  });

  // Ensure engine is "running" so abortCycleIfNeeded doesn't abort
  engine.isRunning = true;
  (engine as any).cycleAbortToken = 0;

  return { engine, messages };
}

// ---------------------------------------------------------------------------
// DB mock — generic pass-through that records calls
// ---------------------------------------------------------------------------

beforeEach(() => {
  setMockRunQuery(async (_sql: string, _params: any[] = [], _type: 'run' | 'all' = 'run') => {
    if (_sql.includes('SELECT')) return [];
    return { changes: 1 };
  });
});

afterEach(() => {
  clearMockRunQuery();
});

// ===========================================================================
// fetchMarketData
// ===========================================================================

describe('TradingEngine.fetchMarketData [T4]', () => {
  test('returns CycleMarketData when exchange provides >= 20 candles', async () => {
    const { engine } = createEngine({ candles: makeCandles(50) });
    const ctx = makeCtx({ cycleToken: 0 });

    const result = await (engine as any).fetchMarketData(ctx);
    assert.ok(result, 'should return data');
    assert.equal(result.candles.length, 50);
  });

  test('returns null when exchange provides < 20 candles (no-signal cycle)', async () => {
    const { engine } = createEngine({ candles: makeCandles(10) });
    const ctx = makeCtx({ cycleToken: 0 });

    const result = await (engine as any).fetchMarketData(ctx);
    assert.equal(result, null);
  });

  test('returns null when exchange is null (no candles)', async () => {
    const { engine } = createEngine();
    engine.exchange = null;
    const ctx = makeCtx({ cycleToken: 0 });

    const result = await (engine as any).fetchMarketData(ctx);
    assert.equal(result, null);
  });
});

// ===========================================================================
// computeIndicators
// ===========================================================================

describe('TradingEngine.computeIndicators [T4]', () => {
  test('returns IndicatorSet with df when candles produce indicators', () => {
    const { engine } = createEngine({ candles: makeCandles(50) });
    const ctx = makeCtx({ cycleToken: 0 });
    const data = { candles: makeCandles(50) };

    const result = (engine as any).computeIndicators(ctx, data);
    assert.ok(result);
    assert.ok(result.df.length > 0);
  });

  test('returns null when df is empty', () => {
    const { engine } = createEngine();
    // Stub calculateAll to return empty
    engine.indicators.calculateAll = () => [];
    const ctx = makeCtx({ cycleToken: 0 });
    const data = { candles: makeCandles(50) };

    const result = (engine as any).computeIndicators(ctx, data);
    assert.equal(result, null);
  });
});

// ===========================================================================
// detectRegimeStage
// ===========================================================================

describe('TradingEngine.detectRegimeStage [T4]', () => {
  test('returns manual regime when manualRegime is set', async () => {
    const { engine } = createEngine();
    const ctx = makeCtx({ manualRegime: RegimeType.STRONG_BULL, cycleToken: 0 });
    const data = { candles: makeCandles(50) };
    const indicators = { df: makeCandles(50) };

    const result = await (engine as any).detectRegimeStage(ctx, data, indicators);
    assert.ok(result);
    assert.equal(result.regime, RegimeType.STRONG_BULL);
    assert.equal(result.confidence, 100);
  });

  test('uses RegimeDetector.detect when no manualRegime (AI path)', async () => {
    const { engine } = createEngine({
      regimeResult: { regime: RegimeType.BEAR, confidence: 80, reasoning: 'downtrend', metrics: {}, timestamp: Date.now() },
    });
    const ctx = makeCtx({ manualRegime: null, cycleToken: 0 });
    const data = { candles: makeCandles(50) };
    const indicators = { df: makeCandles(50) };

    const result = await (engine as any).detectRegimeStage(ctx, data, indicators);
    assert.ok(result);
    assert.equal(result.regime, RegimeType.BEAR);
    assert.equal(result.confidence, 80);
  });
});

// ===========================================================================
// persistRegimeAndApplyChange
// ===========================================================================

describe('TradingEngine.persistRegimeAndApplyChange [T4]', () => {
  test('persists regime history and broadcasts when regime changes (shouldUpdate=true)', async () => {
    const { engine, messages } = createEngine({ shouldUpdateRegime: true });
    engine.currentRegime = RegimeType.UNCERTAIN;
    const ctx = makeCtx({ currentRegime: RegimeType.UNCERTAIN, cycleToken: 0 });

    const regimeResult = {
      regime: RegimeType.STRONG_BULL,
      confidence: 85,
      reasoning: 'strong uptrend',
      metrics: {},
      timestamp: Date.now(),
    };

    const result = await (engine as any).persistRegimeAndApplyChange(ctx, regimeResult);
    assert.equal(result, true);
    // engine.currentRegime should have been updated
    assert.equal(engine.currentRegime, RegimeType.STRONG_BULL);
    // A 'regime' broadcast should have been sent
    const regimeMsg = messages.find(m => m.type === 'regime');
    assert.ok(regimeMsg, 'should broadcast regime change');
  });

  test('skips regime history when shouldUpdateRegime=false (stable regime)', async () => {
    const { engine, messages } = createEngine({ shouldUpdateRegime: false });
    engine.currentRegime = RegimeType.SIDEWAYS;
    const ctx = makeCtx({ currentRegime: RegimeType.SIDEWAYS, cycleToken: 0 });

    const regimeResult = {
      regime: RegimeType.SIDEWAYS,
      confidence: 60,
      reasoning: 'flat',
      metrics: {},
      timestamp: Date.now(),
    };

    const result = await (engine as any).persistRegimeAndApplyChange(ctx, regimeResult);
    assert.equal(result, true);
    // No regime broadcast (since regime didn't change)
    const regimeMsg = messages.find(m => m.type === 'regime');
    assert.equal(regimeMsg, undefined);
  });

  test('persists composite to regimes_v2 when present', async () => {
    let v2Inserted = false;
    setMockRunQuery(async (sql: string) => {
      if (sql.includes('INSERT INTO regimes_v2')) v2Inserted = true;
      if (sql.includes('SELECT')) return [];
      return { changes: 1 };
    });

    const { engine } = createEngine({ shouldUpdateRegime: false });
    const ctx = makeCtx({ currentRegime: RegimeType.UNCERTAIN, cycleToken: 0 });

    const regimeResult = {
      regime: RegimeType.UNCERTAIN,
      confidence: 50,
      reasoning: 'test',
      metrics: {},
      timestamp: Date.now(),
      composite: { trend: 'up', vol: 'normal' },
      trendDir: 'up',
      trendStrength: 'moderate',
      volRegime: 'normal',
      stability: 0.9,
      atrPercentile: 0.5,
      atrUsable: true,
    };

    await (engine as any).persistRegimeAndApplyChange(ctx, regimeResult);
    assert.ok(v2Inserted, 'should insert into regimes_v2 when composite is present');
  });
});

// ===========================================================================
// generateSignalsStage
// ===========================================================================

describe('TradingEngine.generateSignalsStage [T4]', () => {
  test('returns signal stage result with signal present', async () => {
    const signal = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      confidence: 85,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 51000,
      reasoning: 'bullish',
      indicators: ['ema_cross'],
    };
    const { engine } = createEngine({ signal });
    const ctx = makeCtx({ currentRegime: RegimeType.STRONG_BULL, cycleToken: 0 });
    const indicators = { df: makeCandles(50) };

    const result = await (engine as any).generateSignalsStage(ctx, indicators);
    assert.ok(result);
    assert.ok(result.signal);
    assert.equal(result.signal.side, 'buy');
  });

  test('returns null signal but still has liveConfidence when no signal (no-signal cycle)', async () => {
    const { engine } = createEngine({ signal: null });
    const ctx = makeCtx({ currentRegime: RegimeType.UNCERTAIN, cycleToken: 0 });
    const indicators = { df: makeCandles(50) };

    const result = await (engine as any).generateSignalsStage(ctx, indicators);
    assert.ok(result);
    assert.equal(result.signal, null);
    assert.ok(result.liveConfidence);
    assert.equal(result.liveConfidence.score, 42);
  });
});

// ===========================================================================
// broadcastSignalStatus
// ===========================================================================

describe('TradingEngine.broadcastSignalStatus [T4]', () => {
  test('broadcasts signal_status with hasSignal=true when signal is present', () => {
    const { engine, messages } = createEngine();
    const ctx = makeCtx({ currentRegime: RegimeType.STRONG_BULL, activeMode: 'aggressive' });
    const signal = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      confidence: 90,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 51000,
      reasoning: 'strong',
      indicators: ['rsi'],
      mlDisagreement: false,
      mlScore: 0.8,
      mlDirection: 'buy' as const,
    };
    const liveConfidence = { score: 75, side: 'buy', indicators: ['rsi'], distances: {} };
    const latestCandle = { close: 50000, price_change_24h: 2.5 };

    (engine as any).broadcastSignalStatus(ctx, signal, liveConfidence, latestCandle);

    const msg = messages.find(m => m.type === 'signal_status');
    assert.ok(msg);
    assert.equal(msg.data.hasSignal, true);
    assert.equal(msg.data.signal.side, 'buy');
    assert.equal(msg.data.signal.confidence, 90);
    assert.equal(msg.data.regime, RegimeType.STRONG_BULL);
    assert.equal(msg.data.activeMode, 'aggressive');
    assert.equal(msg.data.currentPrice, 50000);
  });

  test('broadcasts signal_status with hasSignal=false and null signal when no signal', () => {
    const { engine, messages } = createEngine();
    const ctx = makeCtx({ currentRegime: RegimeType.UNCERTAIN, activeMode: 'moderate' });
    const liveConfidence = { score: 30, side: 'neutral', indicators: ['waiting'], distances: {} };
    const latestCandle = { close: 45000, price_change_24h: -1.2 };

    (engine as any).broadcastSignalStatus(ctx, null, liveConfidence, latestCandle);

    const msg = messages.find(m => m.type === 'signal_status');
    assert.ok(msg);
    assert.equal(msg.data.hasSignal, false);
    assert.equal(msg.data.signal, null);
    assert.equal(msg.data.liveConfidence, 30);
    assert.equal(msg.data.regime, RegimeType.UNCERTAIN);
  });
});

// ===========================================================================
// broadcastSignalRecord
// ===========================================================================

describe('TradingEngine.broadcastSignalRecord [T4]', () => {
  test('broadcasts signal_record with signal fields when signal is present', () => {
    const { engine, messages } = createEngine();
    const ctx = makeCtx({ currentRegime: RegimeType.BEAR, strategy: 'regime' });
    const signal = {
      symbol: 'BTC/USDT',
      side: 'sell' as const,
      confidence: 80,
      entryPrice: 50000,
      stopLoss: 51000,
      takeProfit: 49000,
      reasoning: 'bearish',
      indicators: ['macd'],
    };
    const liveConfidence = { score: 65, side: 'sell', indicators: ['macd'], distances: {} };
    const latestCandle = { close: 49800 };

    (engine as any).broadcastSignalRecord(ctx, 'sig-123', signal, liveConfidence, latestCandle);

    const msg = messages.find(m => m.type === 'signal_record');
    assert.ok(msg);
    assert.equal(msg.data.id, 'sig-123');
    assert.equal(msg.data.side, 'sell');
    assert.equal(msg.data.confidence, 80);
    assert.equal(msg.data.regime, RegimeType.BEAR);
    assert.equal(msg.data.entry_price, 50000);
  });

  test('broadcasts signal_record with liveConfidence fallback when signal is null', () => {
    const { engine, messages } = createEngine();
    const ctx = makeCtx({ currentRegime: RegimeType.SIDEWAYS, strategy: 'regime' });
    const liveConfidence = { score: 35, side: 'neutral', indicators: ['bb'], distances: {} };
    const latestCandle = { close: 45000 };

    (engine as any).broadcastSignalRecord(ctx, 'sig-456', null, liveConfidence, latestCandle);

    const msg = messages.find(m => m.type === 'signal_record');
    assert.ok(msg);
    assert.equal(msg.data.id, 'sig-456');
    assert.equal(msg.data.side, 'neutral');
    assert.equal(msg.data.confidence, 35);
    assert.equal(msg.data.entry_price, 45000);
    assert.equal(msg.data.liveConfidence, 35);
  });
});

// ===========================================================================
// persistSignalRecord
// ===========================================================================

describe('TradingEngine.persistSignalRecord [T4]', () => {
  test('returns true and persists signal to DB', async () => {
    let insertCalled = false;
    setMockRunQuery(async (sql: string) => {
      if (sql.includes('INSERT INTO signals')) insertCalled = true;
      if (sql.includes('SELECT')) return [];
      return { changes: 1 };
    });

    const { engine } = createEngine();
    const ctx = makeCtx({ currentRegime: RegimeType.STRONG_BULL, cycleToken: 0 });
    const signal = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      confidence: 90,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 51000,
      reasoning: 'test',
      indicators: ['ema'],
      mlScore: 0.85,
    };
    const liveConfidence = { score: 80, side: 'buy', indicators: ['ema'], distances: {} };
    const latestCandle = { close: 50000 };

    const result = await (engine as any).persistSignalRecord(ctx, signal, liveConfidence, latestCandle);
    assert.equal(result, true);
    assert.ok(insertCalled, 'should INSERT INTO signals');
  });

  test('returns true even when DB insert fails (graceful degradation)', async () => {
    setMockRunQuery(async () => {
      throw new Error('DB error');
    });

    const { engine } = createEngine();
    const ctx = makeCtx({ currentRegime: RegimeType.UNCERTAIN, cycleToken: 0 });
    const liveConfidence = { score: 20, side: 'neutral', indicators: [], distances: {} };
    const latestCandle = { close: 45000 };

    const result = await (engine as any).persistSignalRecord(ctx, null, liveConfidence, latestCandle);
    assert.equal(result, true);
  });
});

// ===========================================================================
// broadcastCycleStage
// ===========================================================================

describe('TradingEngine.broadcastCycleStage [T4]', () => {
  test('broadcasts performance, balances, and candle', async () => {
    const { engine, messages } = createEngine();
    const ctx = makeCtx({ cycleToken: 0 });
    const indicators = { df: [...makeCandles(50), { close: 505, time: Date.now(), price_change_24h: 1.5 }] };

    const result = await (engine as any).broadcastCycleStage(ctx, indicators);
    assert.equal(result, true);

    const perfMsg = messages.find(m => m.type === 'performance');
    assert.ok(perfMsg, 'should broadcast performance');

    const balMsg = messages.find(m => m.type === 'balances');
    assert.ok(balMsg, 'should broadcast balances');

    const candleMsg = messages.find(m => m.type === 'candle');
    assert.ok(candleMsg, 'should broadcast candle');
    assert.equal(candleMsg.data.close, 505);
  });

  test('uses lastPerformance fallback when getPerformance throws', async () => {
    const { engine, messages } = createEngine();
    // Make getPerformance throw on first call, then return fallback
    (engine as any).shadowTrader.getPerformance = () => {
      throw new Error('perf error');
    };
    (engine as any).lastPerformance = { moderate: { balance: 99000 } };

    const ctx = makeCtx({ cycleToken: 0 });
    const indicators = { df: makeCandles(50) };

    const result = await (engine as any).broadcastCycleStage(ctx, indicators);
    assert.equal(result, true);

    const perfMsg = messages.find(m => m.type === 'performance');
    assert.ok(perfMsg);
    assert.ok(perfMsg.data.moderate);
    assert.equal(perfMsg.data.moderate.balance, 99000);
  });
});

// ===========================================================================
// applyAiStrategySwitch (fallback path — AI unavailable)
// ===========================================================================

describe('TradingEngine.applyAiStrategySwitch [T4]', () => {
  test('falls back to conservative mode for sideways regime when AI import fails', async () => {
    const { engine, messages } = createEngine();
    engine.currentRegime = RegimeType.SIDEWAYS;
    const ctx = makeCtx({ currentRegime: RegimeType.SIDEWAYS, cycleToken: 0 });

    const regimeResult = {
      regime: RegimeType.SIDEWAYS,
      confidence: 80,
      reasoning: 'sideways market',
      metrics: {},
      timestamp: Date.now(),
    };

    // The OpenAI import will fail (no ollama running), triggering catch block
    await (engine as any).applyAiStrategySwitch(ctx, regimeResult);

    // Fallback: sideways → conservative
    assert.equal(engine.activeMode, 'conservative');
    assert.equal(ctx.activeMode, 'conservative');

    const switchMsg = messages.find(m => m.type === 'ai_mode_switch');
    assert.ok(switchMsg);
    assert.equal(switchMsg.data.mode, 'conservative');
  });

  test('falls back to aggressive for strongbull regime', async () => {
    const { engine, messages } = createEngine();
    engine.currentRegime = RegimeType.STRONG_BULL;
    const ctx = makeCtx({ currentRegime: RegimeType.STRONG_BULL, cycleToken: 0 });

    const regimeResult = {
      regime: RegimeType.STRONG_BULL,
      confidence: 90,
      reasoning: 'strong bull',
      metrics: {},
      timestamp: Date.now(),
    };

    await (engine as any).applyAiStrategySwitch(ctx, regimeResult);

    assert.equal(engine.activeMode, 'aggressive');
    const switchMsg = messages.find(m => m.type === 'ai_mode_switch');
    assert.ok(switchMsg);
    assert.equal(switchMsg.data.mode, 'aggressive');
  });
});

// ===========================================================================
// runShadowAndLiveStage
// ===========================================================================

describe('TradingEngine.runShadowAndLiveStage [T4]', () => {
  test('executes shadow trade when signal is present', async () => {
    const { engine } = createEngine({
      signal: {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        confidence: 85,
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        reasoning: 'test',
        indicators: ['ema'],
      },
    });

    // Stub shadow trader methods
    let processCalled = false;
    (engine.shadowTrader as any).processSignal = async () => { processCalled = true; };
    (engine.shadowTrader as any).updatePositions = async () => {};

    const ctx = makeCtx({ cycleToken: 0, activeMode: 'moderate' });
    const indicators = { df: [...makeCandles(50), { close: 100, time: Date.now() }] };
    const signalStage = {
      signal: { symbol: 'BTC/USDT', side: 'buy', confidence: 85, entryPrice: 100, stopLoss: 95, takeProfit: 110, reasoning: 'test', indicators: ['ema'] },
      liveConfidence: { score: 80, side: 'buy', indicators: ['ema'], distances: {} },
      latestCandleData: { close: 100 },
    };

    const result = await (engine as any).runShadowAndLiveStage(ctx, signalStage, indicators);
    assert.equal(result, true);
    assert.ok(processCalled, 'processSignal should be called when signal present');
  });

  test('skips shadow trade but still updates positions when signal is null', async () => {
    const { engine } = createEngine({ signal: null });

    let processCalled = false;
    let updateCalled = false;
    (engine.shadowTrader as any).processSignal = async () => { processCalled = true; };
    (engine.shadowTrader as any).updatePositions = async () => { updateCalled = true; };

    const ctx = makeCtx({ cycleToken: 0 });
    const indicators = { df: [...makeCandles(50), { close: 100, time: Date.now() }] };
    const signalStage = {
      signal: null,
      liveConfidence: { score: 30, side: 'neutral', indicators: [], distances: {} },
      latestCandleData: { close: 100 },
    };

    const result = await (engine as any).runShadowAndLiveStage(ctx, signalStage, indicators);
    assert.equal(result, true);
    assert.equal(processCalled, false, 'processSignal should NOT be called when signal is null');
    assert.ok(updateCalled, 'updatePositions should always be called');
  });
});
