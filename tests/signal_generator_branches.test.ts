import { describe, test } from 'node:test';
import assert from 'node:assert';
import { SignalGenerator } from '../backend/strategy/signal_generator.js';
import { RegimeType } from '../backend/regime/detector.js';

function makeBaseRow(overrides: Record<string, any> = {}) {
  return {
    time: Date.now(),
    open: 100,
    high: 105,
    low: 99,
    close: 102,
    ema_9: 101,
    ema_21: 100,
    ema_50: 98,
    rsi_14: 58,
    bb_upper: 110,
    bb_middle: 100,
    bb_lower: 95,
    vwap: 101,
    adx: 30,
    adx_plus: 28,
    adx_minus: 18,
    stoch_rsi_k: 20,
    stoch_rsi_d: 18,
    macd_line: 1.5,
    signal_line: 1.0,
    macd_histogram: 0.5,
    volume_sma_20: 100,
    volume_ratio: 1.4,
    atr: 2.5,
    ...overrides
  };
}

function makeDf(lastOverrides: Record<string, any> = {}) {
  const filler = Array.from({ length: 60 }).map((_, i) =>
    makeBaseRow({ time: i, close: 100 + i * 0.05, rsi_14: 52, stoch_rsi_k: 45, volume_ratio: 1.1 })
  );
  filler[filler.length - 1] = makeBaseRow(lastOverrides);
  return filler;
}

describe('SignalGenerator branch coverage', () => {
  test('returns null for short datasets', async () => {
    const generator = new SignalGenerator();
    const result = await generator.generateSignal([makeBaseRow()], RegimeType.STRONG_BULL, 'BTC/USDT');
    assert.strictEqual(result, null);
  });

  test('generates regime strategy signals across all regimes', async () => {
    const generator = new SignalGenerator();

    const strongBull = await generator.generateSignal(makeDf(), RegimeType.STRONG_BULL, 'BTC/USDT');
    assert.ok(strongBull && strongBull.side === 'buy');

    const weakBull = await generator.generateSignal(
      makeDf({ close: 95.2, open: 95.1, bb_lower: 95, vwap: 95, rsi_14: 35, volume_ratio: 1.2 }),
      RegimeType.WEAK_BULL,
      'BTC/USDT'
    );
    assert.ok(weakBull && weakBull.side === 'buy');

    const bear = await generator.generateSignal(
      makeDf({ ema_9: 99, ema_21: 101, rsi_14: 68, high: 109.6, bb_upper: 110, close: 101, open: 104, macd_line: -1, signal_line: 0 }),
      RegimeType.BEAR,
      'BTC/USDT'
    );
    assert.ok(bear && bear.side === 'sell');

    const sideways = await generator.generateSignal(
      makeDf({ close: 95.2, bb_lower: 95, rsi_14: 30, stoch_rsi_k: 20, volume_ratio: 1.1 }),
      RegimeType.SIDEWAYS,
      'BTC/USDT'
    );
    assert.ok(sideways);
  });

  test('generates alternate strategy signals and null default for uncertain regime', async () => {
    const generator = new SignalGenerator();
    const shotgun = await generator.generateSignal(makeDf({ rsi_14: 55 }), RegimeType.UNCERTAIN, 'BTC/USDT', false, 'shotgun');
    assert.ok(shotgun && shotgun.reasoning.includes('Shotgun'));

    const alt = await generator.generateSignal(
      makeDf({ close: 110 }),
      RegimeType.UNCERTAIN,
      'BTC/USDT',
      false,
      'alt_chaser'
    );
    assert.ok(alt && ['buy', 'sell'].includes(alt.side));

    const dragons = await generator.generateSignal(makeDf({ rsi_14: 60 }), RegimeType.UNCERTAIN, 'BTC/USDT', false, 'chasing_dragons');
    assert.ok(dragons && dragons.confidence === 75);

    const uncertainDefault = await generator.generateSignal(makeDf(), RegimeType.UNCERTAIN, 'BTC/USDT');
    assert.strictEqual(uncertainDefault, null);
  });
});
