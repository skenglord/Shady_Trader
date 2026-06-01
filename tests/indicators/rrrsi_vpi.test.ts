import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeRRRsi } from '../../backend/indicators/rrRsi.js';
import { computeVPI } from '../../backend/indicators/volumePressureIndex.js';
import { IndicatorEngine } from '../../backend/indicators/engine.js';

describe('RR-RSI (Block 3)', () => {
  const hist = Array.from({ length: 100 }, () => 40 + Math.random() * 20);

  test('thresholds differ by regime', () => {
    const bull = computeRRRsi(hist, 'strongbull');
    const bear = computeRRRsi(hist, 'bear');
    assert.notDeepEqual(
      [bull.thresholds.oversold, bull.thresholds.overbought],
      [bear.thresholds.oversold, bear.thresholds.overbought]
    );
  });

  test('Bug Fix 1: bullishMomentum and bearishMomentum share the same range', () => {
    const s = computeRRRsi(hist, 'weakbull');
    assert.equal(s.flags.bullishMomentum, s.flags.bearishMomentum);
  });

  test('bootstrap incomplete below 50 observations uses fallback', () => {
    const short = [50, 51, 49];
    const s = computeRRRsi(short, 'sideways');
    assert.equal(s.bootstrapComplete, false);
    assert.equal(s.thresholds.oversold, 35); // sideways fallback os
  });
});

describe('VPI (Block 3, Bug Fix 5)', () => {
  test('score always within [-1, +1]', () => {
    for (let i = 0; i < 50; i++) {
      const r = computeVPI(Math.random() * 100, false, false, Math.random() * 3,
        100 + Math.random() * 10, 100, 110, 95);
      assert.ok(r.score >= -1 && r.score <= 1, `score ${r.score} out of range`);
    }
  });

  test('cvdUsed false when no cvdDelta', () => {
    const r = computeVPI(70, false, false, 1.0, 105, 100, 110, 95);
    assert.equal(r.cvdUsed, false);
  });

  test('cvdUsed true when cvdDelta provided', () => {
    const r = computeVPI(70, false, false, 1.0, 105, 100, 110, 95, 500, 300);
    assert.equal(r.cvdUsed, true);
  });

  test('high MFI + bullish body → positive score', () => {
    const r = computeVPI(85, false, false, 1.6, 110, 100, 111, 99);
    assert.ok(r.score > 0);
  });
});

describe('IndicatorEngine WaveTrend/MFI/VPI wired into calculateAll', () => {
  function makeCandles(n: number) {
    const out = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
      p += Math.sin(i / 5) * 2;
      out.push({ time: i * 60000, open: p - 1, high: p + 2, low: p - 2, close: p, volume: 100 + i });
    }
    return out;
  }

  test('calculateAll emits wave_trend_1, mfi, vpi and no stoch_rsi_k', () => {
    const eng = new IndicatorEngine();
    const rows = eng.calculateAll(makeCandles(120));
    assert.ok(rows.length > 0);
    const last = rows[rows.length - 1];
    assert.ok('wave_trend_1' in last, 'wave_trend_1 present');
    assert.ok('mfi' in last, 'mfi present');
    assert.ok('vpi' in last, 'vpi present');
    assert.ok(!('stoch_rsi_k' in last), 'stoch_rsi_k removed');
    assert.ok(last.vpi >= -1 && last.vpi <= 1, 'vpi bounded');
  });
});
