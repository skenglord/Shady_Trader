import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { generateKeyPairSync } from 'node:crypto';
import { ExchangeConnector } from '../../backend/exchange/connector.js';

const originalPost = axios.post;
const originalGet = axios.get;
const connectors: ExchangeConnector[] = [];
const coinbasePrivateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
function connector(exchange: string) {
  const item = new ExchangeConnector(exchange, 'api-key', exchange === 'coinbase' ? coinbasePrivateKey : 'api-secret', 'passphrase', exchange !== 'kraken');
  item.shutdown();
  connectors.push(item);
  return item;
}
afterEach(() => {
  axios.post = originalPost;
  axios.get = originalGet;
  for (const item of connectors.splice(0)) item.shutdown();
});

test('all venue execution surfaces expose account recovery contract', async () => {
  for (const venue of ['binance', 'kraken', 'okx', 'coinbase']) {
    const item = connector(venue);
    assert.ok(item.accountExecutionAdapter, `${venue} adapter`);
    assert.equal(item.accountExecutionAdapter.exchange, venue);
    assert.equal(typeof item.accountExecutionAdapter.listFills, 'function');
    assert.equal(item.accountExecutionAdapter.capabilities.supportsLiveTrading, false, 'unvalidated venue recovery must not authorize live orders');
  }
});

test('account adapter order submission remains disabled until reconciliation validation is complete', async () => {
  for (const venue of ['binance', 'kraken', 'okx', 'coinbase']) {
    const item = connector(venue);
    await assert.rejects(() => item.accountExecutionAdapter.placeOrder({ clientOrderId: 'callerid', symbol: 'BTC/USDT', side: 'buy', quantity: 1, orderType: 'market' }), /live order submission is disabled/);
  }
});

test('Coinbase Advanced Trade authenticated reads use Bearer JWT', async () => {
  let headers: any;
  axios.get = (async (_url: string, config: any) => {
    headers = config.headers;
    return { data: { accounts: [] } };
  }) as any;
  const item = connector('coinbase');
  await item.accountExecutionAdapter.getBalances();
  assert.match(headers.Authorization, /^Bearer /);
});

test('normalizes native Kraken open-order maps, OKX fills, and Binance sell fills', async () => {
  const kraken = connector('kraken');
  axios.post = (async (url: string) => {
    if (url.includes('OpenOrders')) return { data: { error: [], result: { open: { KRAKEN1: { status: 'open', vol: '2', vol_exec: '0', opentm: 1700000000, descr: { pair: 'XBTUSD', type: 'sell' } } } } } };
    return { data: { error: [], result: { closed: {}, count: 0 } } };
  }) as any;
  const open = await kraken.accountExecutionAdapter.listOpenOrders();
  assert.equal(open[0].exchangeOrderId, 'KRAKEN1');
  assert.equal(open[0].side, 'sell');
  assert.equal(open[0].requestedQuantity, 2);

  const okx = connector('okx');
  axios.get = (async () => ({ data: { code: '0', data: [
    { ordId: 'O1', tradeId: 'T1', instId: 'BTC-USDT', side: 'sell', fillSz: '0.2', fillPx: '50000', fee: '-1', feeCcy: 'USDT', ts: '1700000000000' },
    { ordId: 'O2', tradeId: 'T2', instId: 'BTC-USDT', side: 'buy', fillSz: '0.1', fillPx: '50000', fee: '0.25', feeCcy: 'USDT', ts: '1700000000001' },
  ] } })) as any;
  const fills = await okx.accountExecutionAdapter.listFills(0);
  assert.equal(fills.items[0].exchangeFillId, 'T1');
  assert.equal(fills.items[0].side, 'sell');
  assert.equal(fills.items[0].fee, 1, 'OKX negative fees are charges in the venue API');
  assert.equal(fills.items[0].feeCurrency, 'USDT');
  assert.equal(fills.items[1].fee, -0.25, 'OKX positive fees are rebates and must be negative in the canonical ledger');

  const binance = connector('binance');
  axios.get = (async () => ({ data: [{ id: 9, orderId: 3, symbol: 'BTCUSDT', isBuyer: false, qty: '0.1', price: '50000', time: 1700000000000, commission: 0, commissionAsset: 'USDT' }] })) as any;
  const binanceFills = await binance.accountExecutionAdapter.listFills(0);
  assert.equal(binanceFills.items[0].side, 'sell');
  assert.equal(binanceFills.items[0].symbol, 'BTC/USDT');
});

test('venue API error payloads reject instead of becoming empty successful state', async () => {
  axios.get = (async () => ({ data: { code: '1001', msg: 'denied' } })) as any;
  const item = connector('okx');
  await assert.rejects(() => item.accountExecutionAdapter.getBalances(), /OKX API error/);
  axios.get = (async () => ({ data: { success: false, error_response: { message: 'denied' } } })) as any;
  const coinbase = connector('coinbase');
  await assert.rejects(() => coinbase.accountExecutionAdapter.getBalances(), /Coinbase API error/);
});

test('rejects fills without an exchange timestamp instead of inventing one', async () => {
  axios.get = (async () => ({ data: { code: '0', data: [{ ordId: 'O2', tradeId: 'T2', instId: 'BTC-USDT', side: 'buy', fillSz: '0.1', fillPx: '50000', fee: '0', feeCcy: 'USDT' }] } })) as any;
  const item = connector('okx');
  await assert.rejects(() => item.accountExecutionAdapter.listFills(0), /valid timestamp/);
});

test('Kraken history uses documented cursor pagination for orders and fills', async () => {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  axios.post = (async (url: string, body: string) => {
    const params = new URLSearchParams(body);
    calls.push({ url, body: params });
    if (url.endsWith('/ClosedOrders')) return { data: { error: [], result: { closed: { K1: { status: 'closed', vol: '1', vol_exec: '1', closetm: 1700000000, descr: { pair: 'XBTUSD', type: 'buy' } } }, count: 0, cursor: { next: 'orders-next' } } } };
    if (url.endsWith('/TradesHistory')) return { data: { error: [], result: { trades: { T1: { ordertxid: 'K1', pair: 'XXBTZUSD', type: 'buy', vol: '1', price: '50000', fee: '0', time: 1700000000, trade_id: 10 } }, count: 0, cursor: { next: 'fills-next' } } } };
    return { data: { error: [], result: {} } };
  }) as any;
  const item = connector('kraken');
  const firstOrders = await item.accountExecutionAdapter.listOrders(0);
  const nextOrders = await item.accountExecutionAdapter.listOrders(0, firstOrders.nextCursor!);
  const firstFills = await item.accountExecutionAdapter.listFills(0);
  const nextFills = await item.accountExecutionAdapter.listFills(0, firstFills.nextCursor!);
  assert.equal(firstOrders.nextCursor, 'orders-next');
  assert.equal(nextOrders.nextCursor, 'orders-next');
  assert.equal(firstFills.nextCursor, 'fills-next');
  assert.equal(nextFills.nextCursor, 'fills-next');
  assert.ok(calls.every(call => call.body.get('with_cursor') === 'true'));
  assert.ok(calls.every(call => !call.body.has('ofs')));
  assert.equal(calls[1].body.get('cursor'), 'orders-next');
  assert.equal(calls[3].body.get('cursor'), 'fills-next');
});

test('Coinbase fill pages normalize native entry IDs and carry the returned cursor', async () => {
  const requests: Array<{ config: any }> = [];
  axios.get = (async (_url: string, config: any) => {
    requests.push({ config });
    return { data: { fills: [{ entry_id: 'entry-1', trade_id: 'trade-1', order_id: 'order-1', trade_time: '2026-10-11T12:00:00Z', price: '100', size: '0.25', commission: '0.50', product_id: 'BTC-USD', side: 'BUY' }], ...(requests.length === 1 ? { cursor: 'fills-next' } : {}) } };
  }) as any;
  const item = connector('coinbase');
  const first = await item.accountExecutionAdapter.listFills(0);
  const second = await item.accountExecutionAdapter.listFills(0, first.nextCursor!);
  assert.equal(first.items[0].exchangeFillId, 'entry-1');
  assert.equal(first.items[0].exchangeOrderId, 'order-1');
  assert.equal(first.items[0].feeCurrency, 'USD');
  assert.equal(first.nextCursor, 'fills-next');
  assert.equal(second.nextCursor, null);
  assert.equal(requests[1].config.params.cursor, 'fills-next');
});

test('Coinbase fill history rejects has_next without a cursor', async () => {
  axios.get = (async () => ({ data: { fills: [], has_next: true } })) as any;
  const item = connector('coinbase');
  await assert.rejects(() => item.accountExecutionAdapter.listFills(0), /fill pagination is incomplete/);
});

test('Coinbase order history rejects has_next without a cursor', async () => {
  axios.get = (async () => ({ data: { orders: [], has_next: true } })) as any;
  const item = connector('coinbase');
  await assert.rejects(() => item.accountExecutionAdapter.listOrders(0), /pagination is incomplete/);
});

test('OKX uses the three-month order archive and advances by order ID', async () => {
  const urls: string[] = [];
  axios.get = (async (url: string) => {
    urls.push(url);
    return { data: { code: '0', data: Array.from({ length: 100 }, (_, index) => ({ ordId: String(index + 1), instId: 'BTC-USDT', side: 'buy', sz: '1', accFillSz: '1', state: 'filled', uTime: '1700000000000' })) } };
  }) as any;
  const item = connector('okx');
  const first = await item.accountExecutionAdapter.listOrders(0);
  await item.accountExecutionAdapter.listOrders(0, first.nextCursor!);
  assert.match(urls[0], /\/api\/v5\/trade\/orders-history-archive\?/);
  assert.equal(first.nextCursor, '100');
  assert.match(urls[1], /after=100/);
});

test('Binance rejects legacy native-only cursors that lack symbol scope', async () => {
  const item = connector('binance');
  await assert.rejects(() => item.accountExecutionAdapter.listOrders(1, '1001'), /invalid orders pagination cursor/);
  await assert.rejects(() => item.accountExecutionAdapter.listFills(1, '1001'), /invalid fills pagination cursor/);
});

test('Binance order history advances across every supported Spot symbol with symbol-scoped cursors', async () => {
  const requests: Array<{ params: any; data: any[] }> = [];
  const responses = [
    Array.from({ length: 1000 }, (_, index) => ({ orderId: index + 1, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1', updateTime: 1700000000000 })),
    [{ orderId: 1001, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1', updateTime: 1700000000000 }],
    Array.from({ length: 1000 }, (_, index) => ({ orderId: index + 1, symbol: 'ETHUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1', updateTime: 1700000000000 })),
    [{ orderId: 1001, symbol: 'ETHUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1', updateTime: 1700000000000 }],
    [],
  ];
  axios.get = (async (_url: string, config: any) => {
    const data = responses.shift()!;
    requests.push({ params: config.params, data });
    return { data };
  }) as any;
  const item = connector('binance');
  const first = await item.accountExecutionAdapter.listOrders(1);
  const second = await item.accountExecutionAdapter.listOrders(1, first.nextCursor!);
  const third = await item.accountExecutionAdapter.listOrders(1, second.nextCursor!);
  const fourth = await item.accountExecutionAdapter.listOrders(1, third.nextCursor!);
  const fifth = await item.accountExecutionAdapter.listOrders(1, fourth.nextCursor!);
  const params = (index: number, key: string) => requests[index].params instanceof URLSearchParams ? requests[index].params.get(key) : requests[index].params[key];
  assert.ok(first.nextCursor);
  assert.ok(second.nextCursor);
  assert.ok(third.nextCursor);
  assert.ok(fourth.nextCursor);
  assert.equal(fifth.nextCursor, null);
  assert.deepEqual(requests.map((_, index) => params(index, 'symbol')), ['BTCUSDT', 'BTCUSDT', 'ETHUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(params(0, 'startTime'), '1');
  assert.equal(params(1, 'orderId'), '1001');
  assert.equal(params(2, 'startTime'), '1');
  assert.equal(params(3, 'orderId'), '1001');
  assert.equal(params(4, 'startTime'), '1');
});

test('Binance fill history advances across every supported Spot symbol with symbol-scoped cursors', async () => {
  const requests: Array<{ params: any }> = [];
  const responses = [
    Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, orderId: 10, symbol: 'BTCUSDT', isBuyer: true, qty: '1', price: '100', time: 1700000000000, commission: 0, commissionAsset: 'USDT' })),
    [{ id: 1001, orderId: 10, symbol: 'BTCUSDT', isBuyer: true, qty: '1', price: '100', time: 1700000000000, commission: 0, commissionAsset: 'USDT' }],
    Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, orderId: 20, symbol: 'ETHUSDT', isBuyer: true, qty: '1', price: '100', time: 1700000000000, commission: 0, commissionAsset: 'USDT' })),
    [{ id: 1001, orderId: 20, symbol: 'ETHUSDT', isBuyer: true, qty: '1', price: '100', time: 1700000000000, commission: 0, commissionAsset: 'USDT' }],
    [],
  ];
  axios.get = (async (_url: string, config: any) => {
    requests.push({ params: config.params });
    return { data: responses.shift()! };
  }) as any;
  const item = connector('binance');
  const first = await item.accountExecutionAdapter.listFills(1);
  const second = await item.accountExecutionAdapter.listFills(1, first.nextCursor!);
  const third = await item.accountExecutionAdapter.listFills(1, second.nextCursor!);
  const fourth = await item.accountExecutionAdapter.listFills(1, third.nextCursor!);
  const fifth = await item.accountExecutionAdapter.listFills(1, fourth.nextCursor!);
  const params = (index: number, key: string) => requests[index].params instanceof URLSearchParams ? requests[index].params.get(key) : requests[index].params[key];
  assert.ok(first.nextCursor);
  assert.ok(second.nextCursor);
  assert.ok(third.nextCursor);
  assert.ok(fourth.nextCursor);
  assert.equal(fifth.nextCursor, null);
  assert.deepEqual(requests.map((_, index) => params(index, 'symbol')), ['BTCUSDT', 'BTCUSDT', 'ETHUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(params(0, 'startTime'), '1');
  assert.equal(params(1, 'fromId'), '1001');
  assert.equal(params(2, 'startTime'), '1');
  assert.equal(params(3, 'fromId'), '1001');
  assert.equal(params(4, 'startTime'), '1');
});

test('unvalidated adapters cannot submit live orders and Kraken testnet cannot reach production auth', async () => {
  const item = connector('binance');
  await assert.rejects(() => item.placeOrder('BTC/USDT', 'buy', 0.1), /live order submission is disabled/);
  await assert.rejects(() => item.placeOCOOrder('BTC/USDT', 'buy', 0.1, 49000, 51000), /live order submission is disabled/);
  assert.equal(item.getCapabilities().supportsLiveTrading, false);
  const krakenTestnet = new ExchangeConnector('kraken', 'api-key', 'api-secret', undefined, true);
  krakenTestnet.shutdown(); connectors.push(krakenTestnet);
  await assert.rejects(() => krakenTestnet.accountExecutionAdapter.getBalances(), /Kraken Spot testnet is not supported/);
});
