import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDatabase, runQuery } from '../../backend/database.js';
import { runMigrations } from '../../backend/migrations/runner.js';
import { ExchangeConnector } from '../../backend/exchange/connector.js';
import { ProviderRotator } from '../../backend/exchange/provider-rotator.js';

const directory = mkdtempSync(path.join(tmpdir(), 'shady-candles-'));
process.env.DB_PATH = path.join(directory, 'data.sqlite');
const originalGet = axios.get;
const intervals = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
function candles(tf = '1h', age = 0) {
  const ms = intervals[tf as keyof typeof intervals];
  const latest = Math.floor(Date.now() / ms) * ms - age;
  return Array.from({ length: 60 }, (_, i) => ({ time: latest - (59 - i) * ms, open: 100, high: 110, low: 90, close: 105, volume: 20 }));
}
function connector() {
  const instance = new ExchangeConnector('coingecko', '', '');
  instance.shutdown();
  return instance;
}
before(async () => { await initDatabase(); await runMigrations(); });
afterEach(() => { axios.get = originalGet; });
after(() => rmSync(directory, { recursive: true, force: true }));

test('every supported pair and interval survives provider outage without changing resolution', async () => {
  for (const symbol of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) {
    for (const tf of Object.keys(intervals)) {
      axios.get = (async (url: string, options: any) => {
        if (!url.includes('/klines')) throw new Error('provider unavailable');
        assert.equal(options.params.symbol, symbol.replace('/', ''));
        return { data: candles(options.params.interval).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) };
      }) as any;
      const result = await new ProviderRotator().getCandles(symbol, tf, 60);
      assert.equal(result.length, 60, `${symbol} ${tf}`);
      assert.equal(result[1].time - result[0].time, intervals[tf as keyof typeof intervals], `${symbol} ${tf}`);
    }
  }
});

test('provider rotation rejects stale bars, malformed envelopes and wrong interval spacing', async () => {
  for (const rows of [candles('1h', 86_400_000), candles('4h'), candles().map(c => ({ ...c, high: 80 }))]) {
    axios.get = (async (url: string) => {
      if (!url.includes('/klines')) throw new Error('offline');
      return { data: rows.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) };
    }) as any;
    assert.deepEqual(await new ProviderRotator().getCandles('SOL/USDT', '1h', 60), []);
  }
});

test('CoinGecko USD data is unavailable for a USDT series instead of substituting its quote', async () => {
  axios.get = (async (url: string) => {
    if (!url.includes('/coins/solana/ohlc')) throw new Error('offline');
    return { data: candles('4h').map(c => [c.time, c.open, c.high, c.low, c.close]) };
  }) as any;
  assert.deepEqual(await new ProviderRotator().getCandles('SOL/USDT', '4h', 60), []);
});

test('provider snapshots replace unfinished rows and persist provenance through connector restart', async () => {
  const instance = connector();
  const rows = candles();
  instance.providerRotator.getCandles = async () => rows;
  await instance.getCandles('BTC/USDT', '1h', 60);
  rows[58] = { ...rows[58], high: 115, close: 112, volume: 42 };
  await instance.getCandles('BTC/USDT', '1h', 60);
  const stored = await runQuery('SELECT close, volume FROM candles WHERE symbol = ? AND timeframe = ? AND time = ?', ['BTC/USDT', '1h', rows[58].time], 'all');
  assert.deepEqual(stored, [{ close: 112, volume: 42 }]);
  const restarted = connector();
  restarted.providerRotator.getCandles = async () => [];
  restarted.fetchCryptoCompareHistorical = async () => [];
  const restored = await restarted.getCandles('BTC/USDT', '1h', 60);
  assert.equal(restored.at(-2)?.close, 112);
  assert.equal(restored.at(-2)?.finalized, true);
  assert.equal(restored.at(-2)?.symbol, 'BTC/USDT');
});

test('outage rejects stale database bars while historical research can read them', async () => {
  const instance = connector();
  instance.providerRotator.getCandles = async () => [];
  instance.fetchCryptoCompareHistorical = async () => [];
  const rows = candles('1h', 864_000_000);
  for (const c of rows) await runQuery('INSERT OR REPLACE INTO candles (symbol,timeframe,time,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?,?)', ['ETH/USDT', '1h', c.time, c.open, c.high, c.low, c.close, c.volume]);
  assert.deepEqual(await instance.getCandles('ETH/USDT', '1h', 60), []);
  assert.equal((await instance.getHistoricalCandles('ETH/USDT', '1h', 0, 60)).length, 60);
});

test('CryptoCompare requests the proper endpoint, aggregation and quote for each interval', async () => {
  const instance = connector();
  for (const [tf, endpoint, aggregate] of [['1m', 'histominute', 1], ['5m', 'histominute', 5], ['15m', 'histominute', 15], ['1h', 'histohour', 1], ['4h', 'histohour', 4], ['1d', 'histoday', 1]] as const) {
    let actual: any;
    axios.get = (async (url: string, options: any) => { actual = { url, ...options.params }; return { data: { Data: { Data: candles(tf).map(c => ({ ...c, time: c.time / 1000, volumefrom: c.volume, volumeto: 9999 })) } } }; }) as any;
    const result = await instance.fetchCryptoCompareHistorical('SOL/USDT', tf, 60);
    assert.ok(actual.url.endsWith(endpoint));
    assert.equal(actual.aggregate, aggregate);
    assert.equal(actual.tsym, 'USDT');
    assert.equal(result[0].volume, 20);
  }
});

test('quotes stay keyed by symbol and do not return an old symbol price after an outage', async () => {
  const instance = connector();
  instance.providerRotator.fetchPrice = async (symbol: string) => symbol === 'BTC/USDT' ? 65000 : 150;
  assert.equal(await instance.getCurrentPrice('BTC/USDT'), 65000);
  assert.equal(await instance.getCurrentPrice('SOL/USDT'), 150);
  instance.providerRotator.fetchPrice = async () => 0;
  axios.get = (async () => { throw new Error('offline'); }) as any;
  await assert.rejects(instance.getCurrentPrice('ETH/USDT'), /unavailable|fresh/i);
});
