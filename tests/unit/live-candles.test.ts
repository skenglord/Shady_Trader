import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLiveCandle } from '../../src/chart/live-candles.js';
const market = { symbol: 'BTC/USDT', timeframe: '15m' };
const bar = { ...market, time: 1791931500000, open: 100, high: 102, low: 99, close: 101 };
test('stream updates preserve millisecond history and replace the same bar', () => {
  const data = [{ ...bar, close: 100 }];
  const update = mergeLiveCandle(data, bar, market);
  assert.equal(data.length, 1);
  assert.equal(data[0].time, bar.time);
  assert.equal(data[0].close, 101);
  assert.equal(update?.time, bar.time / 1000);
  mergeLiveCandle(data, { ...bar, time: bar.time + 900000 }, market);
  assert.equal(data.length, 2);
});
test('older, invalid and other-market frames cannot corrupt the current chart', () => {
  const data = [{ ...bar }];
  for (const incoming of [{ ...bar, time: bar.time - 900000 }, { ...bar, symbol: 'ETH/USDT' },
    { ...bar, timeframe: '1m' }, { ...bar, close: NaN }]) {
    assert.equal(mergeLiveCandle(data, incoming, market), null);
  }
  assert.deepEqual(data, [bar]);
});
