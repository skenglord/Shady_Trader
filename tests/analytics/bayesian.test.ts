import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeModeAnalytics } from '../../backend/analytics/bayesianAnalytics.js';

describe('Bayesian analytics (Block 13)', () => {
  test('priorDominated true when wins+losses < 50', () => {
    const r = computeModeAnalytics('conservative', 3, 2);
    assert.equal(r.priorDominated, true);
    assert.equal(r.realTrades, 5);
  });

  test('priorDominated false when wins+losses >= 50', () => {
    const r = computeModeAnalytics('moderate', 30, 20);
    assert.equal(r.priorDominated, false);
    assert.equal(r.realTrades, 50);
  });

  test('posterior mean with 0 trades equals prior mean ~0.60', () => {
    const r = computeModeAnalytics('degen', 0, 0);
    assert.ok(Math.abs(r.posteriorMean - 0.6) < 0.01);
  });

  test('credibleHigh95 > credibleLow95 always', () => {
    const r = computeModeAnalytics('aggressive', 10, 5);
    assert.ok(r.credibleHigh95 > r.credibleLow95);
  });
});
