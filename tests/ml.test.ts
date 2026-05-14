import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { scoreEnsemble, EnsembleInput } from '../backend/ml/ensemble_scorer.js';

describe('scoreEnsemble', () => {
  const base: EnsembleInput = {
    mlPrediction: {
      probability: 0.65,
      direction: 'buy',
      topFeatures: [['rsi_z', 0.12], ['ret_1', 0.09], ['vol_ratio', 0.07]],
      modelPath: '/models/BTC_USDT_strong_bull.joblib',
      regime: 'strong_bull',
      fallback: false
    },
    gemmaAdjustment: 0.0,
    regimeConfidence: 90,
    regimeName: 'strong_bull',
    cachedSentiment: 0.0
  };

  it('returns 0.5 with shouldTrade=false when fallback=true', () => {
    const input = { ...base, mlPrediction: { ...base.mlPrediction, fallback: true } };
    const result = scoreEnsemble(input);
    expect(result.finalScore).toBe(0.5);
    expect(result.shouldTrade).toBe(false);
    expect(result.direction).toBe('buy');
  });

  it('bullish regime weight > 1 amplifies XGBoost probability', () => {
    const result = scoreEnsemble(base);
    expect(result.finalScore).toBeGreaterThan(0.65);
    expect(result.direction).toBe('buy');
  });

  it('negative gemma adjustment reduces final score', () => {
    const input = { ...base, gemmaAdjustment: -0.3 };
    const result = scoreEnsemble(input);
    expect(result.finalScore).toBeLessThan(0.65);
  });

  it('positive gemma adjustment increases final score', () => {
    const input = { ...base, gemmaAdjustment: 0.2 };
    const result = scoreEnsemble(input);
    expect(result.finalScore).toBeGreaterThan(0.65);
  });

  it('clamped between 0.01 and 0.99 regardless of extreme inputs', () => {
    const extreme = {
      ...base,
      mlPrediction: { ...base.mlPrediction, probability: 0.99 },
      gemmaAdjustment: 0.4,
      regimeName: 'strong_bull',
      regimeConfidence: 100,
      cachedSentiment: 1.0
    };
    const result = scoreEnsemble(extreme);
    expect(result.finalScore).toBeLessThanOrEqual(0.99);
    expect(result.finalScore).toBeGreaterThanOrEqual(0.01);
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
    expect(result.finalScore).toBeLessThan(0.60);
  });

  it('reasoning string is populated and contains all components', () => {
    const result = scoreEnsemble(base);
    expect(result.reasoning).toContain('XGBoost:');
    expect(result.reasoning).toContain('Gemma');
    expect(result.reasoning).toContain('Regime');
    expect(result.reasoning).toContain('Final:');
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
    expect(result.shouldTrade).toBe(false);
  });
});

import { CandleExitManager, parseExitConfig } from '../backend/strategy/candle_exit_manager.js';

describe('CandleExitManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ML_EXIT_CHECKPOINTS = '0.10,0.20,0.50';
    process.env.ML_EXIT_CLOSE_ON_GREEN_AT = '0.20';
    process.env.ML_EXIT_FORCE_CLOSE_AT = '0.90';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ML_EXIT_CHECKPOINTS;
    delete process.env.ML_EXIT_CLOSE_ON_GREEN_AT;
    delete process.env.ML_EXIT_FORCE_CLOSE_AT;
  });

  it('parseExitConfig reads env vars correctly', () => {
    const config = parseExitConfig(300_000);
    expect(config.checkpoints).toEqual([0.10, 0.20, 0.50]);
    expect(config.closeOnGreenAt).toBe(0.20);
    expect(config.forceCloseAt).toBe(0.90);
    expect(config.timeframeMs).toBe(300_000);
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

    expect(mgr.activeTradeCount).toBe(1);
    vi.advanceTimersByTime(timeframeMs * 0.20 + 1);
    await Promise.resolve();

    expect(exitEvents).toContain('green_at_checkpoint');
    expect(mgr.activeTradeCount).toBe(0);
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

    vi.advanceTimersByTime(timeframeMs * 0.20 + 1);
    await Promise.resolve();

    expect(exitEvents).toHaveLength(0);
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

    vi.advanceTimersByTime(timeframeMs * 0.90 + 1);
    await Promise.resolve();

    expect(exitReasons).toContain('force_close');
    expect(mgr.activeTradeCount).toBe(0);
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

    expect(mgr.activeTradeCount).toBe(1);
    mgr.cancelAll('trade-004');
    expect(mgr.activeTradeCount).toBe(0);

    vi.advanceTimersByTime(500_000);
    await Promise.resolve();

    expect(exitEvents).toHaveLength(0);
  });

  it('refuses to schedule duplicate exits for same tradeId', () => {
    const mgr = new CandleExitManager();
    const config = parseExitConfig(300_000);
    const noop = async () => {};

    mgr.scheduleExits('trade-005', 100, Date.now(), config, () => 101, noop);
    mgr.scheduleExits('trade-005', 100, Date.now(), config, () => 101, noop);

    expect(mgr.activeTradeCount).toBe(1);
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
    expect(parseGemmaResponse(raw)).toBeCloseTo(0.15);
  });

  it('strips markdown fences before parsing', () => {
    const raw = '```json\n{"adjustment": -0.2, "reason": "ETF outflow bearish"}\n```';
    expect(parseGemmaResponse(raw)).toBeCloseTo(-0.2);
  });

  it('returns null for non-JSON response', () => {
    const raw = 'I cannot provide financial advice.';
    expect(parseGemmaResponse(raw)).toBeNull();
  });

  it('clamps adjustment above 0.4 to 0.4', () => {
    const raw = '{"adjustment": 0.9, "reason": "extreme bullish"}';
    expect(parseGemmaResponse(raw)).toBe(0.4);
  });

  it('clamps adjustment below -0.4 to -0.4', () => {
    const raw = '{"adjustment": -0.99, "reason": "extreme bearish"}';
    expect(parseGemmaResponse(raw)).toBe(-0.4);
  });

  it('coerces string number to float', () => {
    const raw = '{"adjustment": "0.12", "reason": "slight positive"}';
    expect(parseGemmaResponse(raw)).toBeCloseTo(0.12);
  });

  it('returns null when adjustment key missing', () => {
    const raw = '{"sentiment": "bullish", "reason": "positive news"}';
    expect(parseGemmaResponse(raw)).toBeNull();
  });

  it('handles extra unexpected keys without failing', () => {
    const raw = '{"adjustment": 0.05, "reason": "ok", "extra_field": [1,2,3]}';
    expect(parseGemmaResponse(raw)).toBeCloseTo(0.05);
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
    expect(result.valid).toBe(true);
    expect(result.rows).toBe(2);
    expect(result.cols).toBe(3);
  });

  it('rejects null input', () => {
    expect(validateFeatureResponse(null).valid).toBe(false);
  });

  it('rejects response with missing features key', () => {
    expect(validateFeatureResponse({ feature_cols: ['a'] }).valid).toBe(false);
  });

  it('handles empty features array gracefully', () => {
    const result = validateFeatureResponse({ features: [], feature_cols: [] });
    expect(result.valid).toBe(true);
    expect(result.rows).toBe(0);
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
        regime: 'strong_bull',
        fallback: true
      },
      gemmaAdjustment: 0.4,
      regimeConfidence: 100,
      regimeName: 'strong_bull',
      cachedSentiment: 1.0
    };

    const result = scoreEnsemble(input);
    expect(result.shouldTrade).toBe(false);
    expect(result.finalScore).toBe(0.5);
    expect(result.reasoning).toContain('fallback');
  });

  it('ensemble score is deterministic for same inputs', () => {
    const input: EnsembleInput = {
      mlPrediction: {
        probability: 0.62, direction: 'buy', topFeatures: [],
        modelPath: '/m', regime: 'weak_bull', fallback: false
      },
      gemmaAdjustment: 0.1, regimeConfidence: 75,
      regimeName: 'weak_bull', cachedSentiment: 0.2
    };

    const r1 = scoreEnsemble(input);
    const r2 = scoreEnsemble(input);
    expect(r1.finalScore).toBe(r2.finalScore);
  });
});