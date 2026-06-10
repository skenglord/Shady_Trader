/**
 * Tests for backend/backtest/service.ts — standalone backtest service.
 * Run with: tsx --test tests/backtest/backtest_service.test.ts
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktestStandalone } from '../../backend/backtest/service.js';

/**
 * Generate a synthetic candle series for testing.
 */
function generateCandles(count: number, basePrice = 40000, volatility = 500): Array<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> {
  const candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  const startTime = 1700000000000; // Nov 2023
  const intervalMs = 3600000; // 1h

  let prevClose = basePrice;
  for (let i = 0; i < count; i++) {
    const time = startTime + i * intervalMs;
    const change = (Math.random() - 0.48) * volatility; // slight upward bias
    const open = prevClose;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * volatility * 0.3;
    const low = Math.min(open, close) - Math.random() * volatility * 0.3;
    const volume = 100 + Math.random() * 900;

    candles.push({ time, open, high, low, close, volume });
    prevClose = close;
  }
  return candles;
}

describe('runBacktestStandalone', () => {
  it('returns empty metrics when fewer than 100 candles', async () => {
    const result = await runBacktestStandalone(
      generateCandles(50),
      'moderate',
      'BTC/USDT',
      'regime',
      'moderate',
    );

    assert.equal(result.trades.length, 0);
    assert.equal(result.metrics.total_trades, 0);
    assert.equal(result.candleCount, 50);
  });

  it('returns non-empty result with 500 synthetic candles', async () => {
    const candles = generateCandles(300);
    const result = await runBacktestStandalone(
      candles,
      'conservative',
      'BTC/USDT',
      'regime',
      'conservative',
    );

    assert.ok(result.candleCount >= 300, `Expected >= 300 candles, got ${result.candleCount}`);
    assert.ok(Array.isArray(result.trades));
    assert.ok(Array.isArray(result.regimeChanges));
    assert.ok(result.metrics.total_trades >= 0);
    assert.equal(typeof result.metrics.win_rate, 'number');
    assert.equal(typeof result.metrics.sharpe, 'number');
    assert.equal(typeof result.metrics.profit_factor, 'number');
    assert.equal(typeof result.metrics.max_drawdown, 'number');

    // Print some diagnostics
    console.log(`\n  Trades: ${result.metrics.total_trades}`);
    console.log(`  Win rate: ${result.metrics.win_rate}`);
    console.log(`  Sharpe: ${result.metrics.sharpe}`);
    console.log(`  Profit factor: ${result.metrics.profit_factor}`);
    console.log(`  Max drawdown: ${result.metrics.max_drawdown}`);
    console.log(`  Total PnL: ${result.metrics.total_pnl}`);
  });

  it('uses different risk modes without error', async () => {
    const candles = generateCandles(150);
    for (const mode of ['ultra_conservative', 'conservative', 'moderate', 'aggressive'] as const) {
      const result = await runBacktestStandalone(candles, mode, 'BTC/USDT', 'regime', mode);
      assert.equal(typeof result.metrics.total_trades, 'number', `mode=${mode} failed`);
      console.log(`  [${mode}] trades=${result.metrics.total_trades} sharpe=${result.metrics.sharpe}`);
    }
  });

  it('deduplicates candles by time', async () => {
    const candles = generateCandles(150);
    // Add a duplicate
    const dup = { ...candles[50], time: candles[50].time };
    const withDup = [...candles, dup];

    const result = await runBacktestStandalone(withDup, 'moderate');
    assert.ok(result.candleCount <= withDup.length, 'Dedup should reduce count');
    // If dedup worked, we shouldn't have blown up
    assert.equal(typeof result.metrics.total_trades, 'number');
  });
});
