import { test, describe } from 'node:test';
import assert from 'node:assert';
import { RiskMode, DEFAULT_RISK_CONFIGS } from '../../backend/risk/manager.js';
import {
  getCompositeRegime, getTrendStrength, computeAtrPercentile, getVolatilityRegime
} from '../../backend/regime/detector.js';
import { isCanonicalRegime } from '../../backend/types/regime.js';

// T0.2 — Trade-gating regression: every mode's activeRegimes must (a) be canonical
// and (b) overlap with at least one regime the detector can emit, so trades still fire.
describe('Trade gating after regime cutover', () => {
  test('all activeRegimes values are canonical (no underscores)', () => {
    for (const mode of Object.values(RiskMode)) {
      const cfg: any = (DEFAULT_RISK_CONFIGS as any)[mode];
      for (const r of cfg.activeRegimes) {
        assert.ok(isCanonicalRegime(r), `${mode}: '${r}' must be canonical`);
      }
    }
  });

  test('each mode admits at least one composite regime the detector emits', () => {
    const emittable = ['strongbull', 'weakbull', 'bear', 'sideways', 'uncertain'];
    for (const mode of Object.values(RiskMode)) {
      const cfg: any = (DEFAULT_RISK_CONFIGS as any)[mode];
      const overlap = cfg.activeRegimes.filter((r: string) => emittable.includes(r));
      assert.ok(overlap.length > 0, `${mode} must admit at least one emittable regime`);
    }
  });

  test('conservative mode admits strongbull (representative trade-firing path)', () => {
    const cfg: any = (DEFAULT_RISK_CONFIGS as any)[RiskMode.CONSERVATIVE];
    assert.ok(cfg.activeRegimes.includes('strongbull'));
  });
});

describe('Regime v2 three-axis (Bug Fixes 2,3)', () => {
  test('Bug Fix 3: ALL downtrends map to bear', () => {
    assert.equal(getCompositeRegime('down', 'weak', 'normal'), 'bear');
    assert.equal(getCompositeRegime('down', 'strong', 'high'), 'bear');
    assert.equal(getCompositeRegime('down', 'moderate', 'low'), 'bear');
  });

  test('up+weak maps to sideways', () => {
    assert.equal(getCompositeRegime('up', 'weak', 'normal'), 'sideways');
  });

  test('up+strong=strongbull, up+moderate=weakbull', () => {
    assert.equal(getCompositeRegime('up', 'strong', 'normal'), 'strongbull');
    assert.equal(getCompositeRegime('up', 'moderate', 'normal'), 'weakbull');
  });

  test('Bug Fix 2: ATR percentile not usable below bootstrap min', () => {
    const shortHist = Array.from({ length: 100 }, (_, i) => i + 1);
    const r = computeAtrPercentile(shortHist, 50, 288);
    assert.equal(r.usable, false);
  });

  test('trend strength thresholds', () => {
    assert.equal(getTrendStrength(30), 'strong');
    assert.equal(getTrendStrength(20), 'moderate');
    assert.equal(getTrendStrength(10), 'weak');
  });

  test('volatility regime defaults to normal when not usable', () => {
    assert.equal(getVolatilityRegime({ percentile: 0.9, usable: false }), 'normal');
    assert.equal(getVolatilityRegime({ percentile: 0.9, usable: true }), 'high');
  });
});
