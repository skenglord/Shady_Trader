import { describe, test } from 'node:test';
import assert from 'node:assert';
import { IndicatorEngine, Candle } from '../../backend/indicators/engine.js';

function makeCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += 0.8;
    candles.push({
      time: i * 60_000,
      open: price - 0.5,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 100 + i
    });
  }
  return candles;
}

describe('IndicatorEngine', () => {
  test('throws when candle count is below warmup minimum', () => {
    const engine = new IndicatorEngine();
    assert.throws(() => engine.calculateAll(makeCandles(10)), /Need at least 50 candles/);
  });

  test('calculates aligned indicators and filters warmup rows', () => {
    const engine = new IndicatorEngine();
    const rows = engine.calculateAll(makeCandles(90));
    assert.ok(rows.length > 0);
    const last = rows[rows.length - 1];
    assert.ok(typeof last.ema_50 === 'number');
    assert.ok(typeof last.adx === 'number');
    assert.ok(typeof last.volume_ratio === 'number');
    assert.ok(typeof last.atr === 'number');
  });
});
