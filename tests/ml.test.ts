import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import { scoreEnsemble, EnsembleInput } from '../backend/ml/ensemble_scorer.js';

describe('scoreEnsemble', () => {
  const base: EnsembleInput = {
    mlPrediction: {
      probability: 0.65,
      direction: 'buy',
      topFeatures: [['rsi_z', 0.12], ['ret_1', 0.09], ['vol_ratio', 0.07]],
      modelPath: '/models/BTC_USDT_strong_bull.joblib',
      regime: 'strongbull',
      fallback: false
    },
    gemmaAdjustment: 0.0,
    regimeConfidence: 90,
    regimeName: 'strongbull',
    cachedSentiment: 0.0
  };

  it('returns 0.5 with shouldTrade=false when fallback=true', () => {
    const input = { ...base, mlPrediction: { ...base.mlPrediction, fallback: true } };
    const result = scoreEnsemble(input);
    assert.strictEqual(result.finalScore, 0.5);
    assert.strictEqual(result.shouldTrade, false);
    assert.strictEqual(result.direction, 'buy');
  });

  it('bullish regime weight > 1 amplifies XGBoost probability', () => {
    const result = scoreEnsemble(base);
    assert.ok(result.finalScore > 0.65);
    assert.strictEqual(result.direction, 'buy');
  });

  it('negative gemma adjustment reduces final score', () => {
    const input = { ...base, gemmaAdjustment: -0.3 };
    const result = scoreEnsemble(input);
    assert.ok(result.finalScore < 0.65);
  });

  it('positive gemma adjustment increases final score', () => {
    const input = { ...base, gemmaAdjustment: 0.2 };
    const result = scoreEnsemble(input);
    assert.ok(result.finalScore > 0.65);
  });

  it('clamped between 0.01 and 0.99 regardless of extreme inputs', () => {
    const extreme = {
      ...base,
      mlPrediction: { ...base.mlPrediction, probability: 0.99 },
      gemmaAdjustment: 0.4,
      regimeName: 'strongbull',
      regimeConfidence: 100,
      cachedSentiment: 1.0
    };
    const result = scoreEnsemble(extreme);
    assert.ok(result.finalScore <= 0.99);
    assert.ok(result.finalScore >= 0.01);
  });

  it('bear regime weight reduces score below XGBoost base', () => {
    const bearInput = {
      ...base,
      regimeName: 'bear',
      regimeConfidence: 85,
      cachedSentiment: 0.0,
      mlPrediction: { ...base.mlPrediction, probability: 0.60 }
    };
    const result = scoreEnsemble(bearInput);
    assert.ok(result.finalScore < 0.60);
  });

  it('reasoning string is populated and contains all components', () => {
    const result = scoreEnsemble(base);
    assert.ok(result.reasoning.includes('XGBoost:'));
    assert.ok(result.reasoning.includes('Gemma'));
    assert.ok(result.reasoning.includes('Regime'));
    assert.ok(result.reasoning.includes('Final:'));
  });

  it('shouldTrade false when finalScore within threshold band', () => {
    const input = {
      ...base,
      mlPrediction: { ...base.mlPrediction, probability: 0.53, fallback: false },
      gemmaAdjustment: 0.0,
      regimeName: 'bear',
      regimeConfidence: 80,
    };
    const result = scoreEnsemble(input);
    assert.strictEqual(result.shouldTrade, false);
  });
});

import { CandleExitManager, parseExitConfig } from '../backend/strategy/candle_exit_manager.js';

describe('CandleExitManager', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    process.env.ML_EXIT_CHECKPOINTS = '0.10,0.20,0.50';
    process.env.ML_EXIT_CLOSE_ON_GREEN_AT = '0.20';
    process.env.ML_EXIT_FORCE_CLOSE_AT = '0.90';
  });

  afterEach(() => {
    mock.timers.reset();
    delete process.env.ML_EXIT_CHECKPOINTS;
    delete process.env.ML_EXIT_CLOSE_ON_GREEN_AT;
    delete process.env.ML_EXIT_FORCE_CLOSE_AT;
  });

  it('parseExitConfig reads env vars correctly', () => {
    const config = parseExitConfig(300_000);
    assert.deepStrictEqual(config.checkpoints, [0.10, 0.20, 0.50]);
    assert.strictEqual(config.closeOnGreenAt, 0.20);
    assert.strictEqual(config.forceCloseAt, 0.90);
    assert.strictEqual(config.timeframeMs, 300_000);
  });

  it('fires green_at_checkpoint when price above entry at closeOnGreenAt', async () => {
    const mgr = new CandleExitManager();
    const exitEvents: string[] = [];
    const entryPrice = 100;
    const candleOpenMs = Date.now();
    const timeframeMs = 300_000;

    const config = parseExitConfig(timeframeMs);
    const getPriceNow = () => 101;

    mgr.scheduleExits(
      'trade-001',
      entryPrice,
      candleOpenMs,
      config,
      getPriceNow,
      async (event) => { exitEvents.push(event.reason); }
    );

    assert.strictEqual(mgr.activeTradeCount, 1);
    mock.timers.tick(timeframeMs * 0.20 + 1);
    await Promise.resolve();

    assert.ok(exitEvents.includes('green_at_checkpoint'));
    assert.strictEqual(mgr.activeTradeCount, 0);
  });

  it('does NOT close when in red at closeOnGreenAt checkpoint', async () => {
    const mgr = new CandleExitManager();
    const exitEvents: string[] = [];
    const candleOpenMs = Date.now();
    const timeframeMs = 300_000;
    const config = parseExitConfig(timeframeMs);

    const getPriceNow = () => 99;

    mgr.scheduleExits('trade-002', 100, candleOpenMs, config, getPriceNow,
      async (event) => { exitEvents.push(event.reason); }
    );

    mock.timers.tick(timeframeMs * 0.20 + 1);
    await Promise.resolve();

    assert.strictEqual(exitEvents.length, 0);
  });

  it('force_close fires at forceCloseAt regardless of P&L', async () => {
    const mgr = new CandleExitManager();
    const exitReasons: string[] = [];
    const candleOpenMs = Date.now();
    const timeframeMs = 300_000;
    const config = parseExitConfig(timeframeMs);

    const getPriceNow = () => 98;

    mgr.scheduleExits('trade-003', 100, candleOpenMs, config, getPriceNow,
      async (event) => { exitReasons.push(event.reason); }
    );

    mock.timers.tick(timeframeMs * 0.90 + 1);
    await Promise.resolve();

    assert.ok(exitReasons.includes('force_close'));
    assert.strictEqual(mgr.activeTradeCount, 0);
  });

  it('cancelAll stops all timers for a trade', async () => {
    const mgr = new CandleExitManager();
    const exitEvents: string[] = [];
    const candleOpenMs = Date.now();
    const config = parseExitConfig(300_000);

    mgr.scheduleExits('trade-004', 100, candleOpenMs, config,
      () => 101,
      async (event) => { exitEvents.push(event.reason); }
    );

    assert.strictEqual(mgr.activeTradeCount, 1);
    mgr.cancelAll('trade-004');
    assert.strictEqual(mgr.activeTradeCount, 0);

    mock.timers.tick(500_000);
    await Promise.resolve();

    assert.strictEqual(exitEvents.length, 0);
  });

  it('refuses to schedule duplicate exits for same tradeId', () => {
    const mgr = new CandleExitManager();
    const config = parseExitConfig(300_000);
    const noop = async () => {};

    mgr.scheduleExits('trade-005', 100, Date.now(), config, () => 101, noop);
    mgr.scheduleExits('trade-005', 100, Date.now(), config, () => 101, noop);

    assert.strictEqual(mgr.activeTradeCount, 1);
  });
});

describe('GemmaAdjuster JSON parsing', () => {
  function parseGemmaResponse(raw: string): number | null {
    const cleaned = raw.replace(/```(?:json)?/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const val = Number(parsed.adjustment);
      if (isNaN(val)) return null;
      return Math.max(-0.4, Math.min(0.4, val));
    } catch {
      return null;
    }
  }

  it('parses clean JSON correctly', () => {
    const raw = '{"adjustment": 0.15, "reason": "ETF news confirms bullish trend"}';
    assert.ok(Math.abs(parseGemmaResponse(raw)! - 0.15) < 0.001);
  });

  it('strips markdown fences before parsing', () => {
    const raw = '```json\n{"adjustment": -0.2, "reason": "ETF outflow bearish"}\n```';
    assert.ok(Math.abs(parseGemmaResponse(raw)! - (-0.2)) < 0.001);
  });

  it('returns null for non-JSON response', () => {
    const raw = 'I cannot provide financial advice.';
    assert.strictEqual(parseGemmaResponse(raw), null);
  });

  it('clamps adjustment above 0.4 to 0.4', () => {
    const raw = '{"adjustment": 0.9, "reason": "extreme bullish"}';
    assert.strictEqual(parseGemmaResponse(raw), 0.4);
  });

  it('clamps adjustment below -0.4 to -0.4', () => {
    const raw = '{"adjustment": -0.99, "reason": "extreme bearish"}';
    assert.strictEqual(parseGemmaResponse(raw), -0.4);
  });

  it('coerces string number to float', () => {
    const raw = '{"adjustment": "0.12", "reason": "slight positive"}';
    assert.ok(Math.abs(parseGemmaResponse(raw)! - 0.12) < 0.001);
  });

  it('returns null when adjustment key missing', () => {
    const raw = '{"sentiment": "bullish", "reason": "positive news"}';
    assert.strictEqual(parseGemmaResponse(raw), null);
  });

  it('handles extra unexpected keys without failing', () => {
    const raw = '{"adjustment": 0.05, "reason": "ok", "extra_field": [1,2,3]}';
    assert.ok(Math.abs(parseGemmaResponse(raw)! - 0.05) < 0.001);
  });
});

describe('FeatureResponse parsing', () => {
  function validateFeatureResponse(raw: unknown): {
    valid: boolean;
    rows: number;
    cols: number;
  } {
    if (!raw || typeof raw !== 'object') return { valid: false, rows: 0, cols: 0 };
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.features) || !Array.isArray(r.feature_cols))
      return { valid: false, rows: 0, cols: 0 };
    if (r.features.length === 0) return { valid: true, rows: 0, cols: 0 };
    const firstRow = r.features[0];
    if (!Array.isArray(firstRow)) return { valid: false, rows: 0, cols: 0 };
    return {
      valid: true,
      rows: r.features.length,
      cols: firstRow.length
    };
  }

  it('validates correct feature response shape', () => {
    const response = {
      features: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      feature_cols: ['ret_1', 'rsi_z', 'vol_ratio'],
      n_rows: 2
    };
    const result = validateFeatureResponse(response);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.rows, 2);
    assert.strictEqual(result.cols, 3);
  });

  it('rejects null input', () => {
    assert.strictEqual(validateFeatureResponse(null).valid, false);
  });

  it('rejects response with missing features key', () => {
    assert.strictEqual(validateFeatureResponse({ feature_cols: ['a'] }).valid, false);
  });

  it('handles empty features array gracefully', () => {
    const result = validateFeatureResponse({ features: [], feature_cols: [] });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.rows, 0);
  });
});

describe('MLPrediction fallback integration', () => {
  it('ensemble with fallback=true never triggers a trade', () => {
    const input: EnsembleInput = {
      mlPrediction: {
        probability: 0.99,
        direction: 'buy',
        topFeatures: [],
        modelPath: '',
        regime: 'strongbull',
        fallback: true
      },
      gemmaAdjustment: 0.4,
      regimeConfidence: 100,
      regimeName: 'strongbull',
      cachedSentiment: 1.0
    };

    const result = scoreEnsemble(input);
    assert.strictEqual(result.shouldTrade, false);
    assert.strictEqual(result.finalScore, 0.5);
    assert.ok(result.reasoning.includes('fallback'));
  });

  it('ensemble score is deterministic for same inputs', () => {
    const input: EnsembleInput = {
      mlPrediction: {
        probability: 0.62, direction: 'buy', topFeatures: [],
        modelPath: '/m', regime: 'weakbull', fallback: false
      },
      gemmaAdjustment: 0.1, regimeConfidence: 75,
      regimeName: 'weakbull', cachedSentiment: 0.2
    };

    const r1 = scoreEnsemble(input);
    const r2 = scoreEnsemble(input);
    assert.strictEqual(r1.finalScore, r2.finalScore);
  });
});
