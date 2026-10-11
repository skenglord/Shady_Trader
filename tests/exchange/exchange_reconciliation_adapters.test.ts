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
  axios.get = (async () => ({ data: { code: '0', data: [{ ordId: 'O1', tradeId: 'T1', instId: 'BTC-USDT', side: 'sell', fillSz: '0.2', fillPx: '50000', fee: '-1', feeCcy: 'USDT', ts: '1700000000000' }] } })) as any;
  const fills = await okx.accountExecutionAdapter.listFills(0);
  assert.equal(fills.items[0].exchangeFillId, 'T1');
  assert.equal(fills.items[0].side, 'sell');
  assert.equal(fills.items[0].feeCurrency, 'USDT');

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

test('unvalidated adapters cannot submit live orders and Kraken testnet cannot reach production auth', async () => {
  const item = connector('binance');
  await assert.rejects(() => item.placeOrder('BTC/USDT', 'buy', 0.1), /live order submission is disabled/);
  await assert.rejects(() => item.placeOCOOrder('BTC/USDT', 'buy', 0.1, 49000, 51000), /live order submission is disabled/);
  assert.equal(item.getCapabilities().supportsLiveTrading, false);
  const krakenTestnet = new ExchangeConnector('kraken', 'api-key', 'api-secret', undefined, true);
  krakenTestnet.shutdown(); connectors.push(krakenTestnet);
  await assert.rejects(() => krakenTestnet.accountExecutionAdapter.getBalances(), /Kraken Spot testnet is not supported/);
});
