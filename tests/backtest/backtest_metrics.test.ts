import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeBacktestMetrics } from '../../backend/scripts/backtest.js';

describe('Backtest metrics (Block 10 / Experiment A gate)', () => {
  test('profitFactor > 1 for a profitable trade set', () => {
    const trades = [
      { pnl: 2.0 }, { pnl: -1.0 }, { pnl: 1.5 }, { pnl: -0.5 }, { pnl: 1.0 },
    ];
    const m = computeBacktestMetrics('BTCUSDT', 'conservative', trades);
    assert.ok(m.profitFactor > 1.0, `profitFactor ${m.profitFactor} should exceed 1`);
    assert.equal(m.tradeCount, 5);
    assert.ok(m.winRate > 0 && m.winRate <= 1);
  });

  test('profitFactor < 1 for a losing set fails the gate', () => {
    const trades = [{ pnl: 0.5 }, { pnl: -2.0 }, { pnl: -1.5 }, { pnl: 0.2 }];
    const m = computeBacktestMetrics('ETHUSDT', 'conservative', trades);
    assert.ok(m.profitFactor < 1.0);
  });

  test('costs reduce profit factor when slippage + fees enabled', () => {
    const trades = [{ pnl: 0.2 }, { pnl: 0.2 }, { pnl: -0.1 }];
    const noCost = computeBacktestMetrics('BTCUSDT', 'm', trades);
    const withCost = computeBacktestMetrics('BTCUSDT', 'm', trades, {
      slippageEnabled: true, feesEnabled: true, slippageFrac: 0.0005,
    });
    assert.ok(withCost.profitFactor < noCost.profitFactor);
  });

  test('maxDrawdownPct is non-negative and bounded', () => {
    const trades = [{ pnl: 5 }, { pnl: -10 }, { pnl: -10 }, { pnl: 3 }];
    const m = computeBacktestMetrics('BTCUSDT', 'm', trades);
    assert.ok(m.maxDrawdownPct >= 0 && m.maxDrawdownPct <= 100);
  });

  test('empty trade set yields zeroed metrics (no crash)', () => {
    const m = computeBacktestMetrics('BTCUSDT', 'm', []);
    assert.equal(m.tradeCount, 0);
    assert.equal(m.winRate, 0);
    assert.equal(m.maxDrawdownPct, 0);
  });
});
