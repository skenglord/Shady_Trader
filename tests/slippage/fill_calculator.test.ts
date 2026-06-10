import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeFill, computeNetPnL, adjustStopForSlippage } from '../../backend/slippage/fillCalculator.js';

describe('fillCalculator (Block 7) — fractions only', () => {
  test('buy fill is worse (higher) than mid by slippageFrac', () => {
    const r = computeFill('buy', 100, 0.015, 0.0005);
    assert.equal(r.skipped, false);
    assert.ok(Math.abs(r.fillPrice - 100.05) < 1e-9);
    assert.equal(r.slippageFrac, 0.0005);
  });

  test('sell fill is worse (lower) than mid by slippageFrac', () => {
    const r = computeFill('sell', 100, 0.015, 0.0005);
    assert.ok(Math.abs(r.fillPrice - 99.95) < 1e-9);
  });

  test('totalCostFrac = slippageFrac + feeFrac', () => {
    const r = computeFill('buy', 100, 0.02, 0.001);
    assert.ok(Math.abs(r.totalCostFrac - (r.slippageFrac + r.feeFrac)) < 1e-12);
  });

  test('skips trade when slippage eats too much of TP', () => {
    // slippage 0.01 vs TP distance 0.015 → ratio 0.66 > 0.45 default
    const r = computeFill('buy', 100, 0.015, 0.01);
    assert.equal(r.skipped, true);
    assert.match(r.skipReason!, /Slippage/);
  });

  test('net PnL deducts fees from gross', () => {
    const entry = computeFill('buy', 100, 0.02, 0.0005);
    const exit = computeFill('sell', 102, 0.02, 0.0005);
    const net = computeNetPnL('buy', 1000, entry, exit);
    // gross ~ (102.0 vs 100.05) positive, minus fee fracs * notional
    assert.ok(net < ((exit.fillPrice - entry.fillPrice) / entry.fillPrice) * 1000);
  });

  test('adjustStopForSlippage widens stop in adverse direction', () => {
    assert.ok(adjustStopForSlippage(95, 'buy', 0.001) < 95);
    assert.ok(adjustStopForSlippage(105, 'sell', 0.001) > 105);
    assert.equal(adjustStopForSlippage(95, 'buy', 0), 95);
  });
});
