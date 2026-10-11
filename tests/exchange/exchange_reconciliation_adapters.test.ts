import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { generateKeyPairSync } from 'node:crypto';
import { ExchangeConnector } from '../../backend/exchange/connector.js';

const originalPost = axios.post;
const connectors: ExchangeConnector[] = [];
const coinbasePrivateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
function connector(exchange: string) {
  const item = new ExchangeConnector(exchange, 'api-key', exchange === 'coinbase' ? coinbasePrivateKey : 'api-secret', 'passphrase', true);
  item.shutdown();
  connectors.push(item);
  return item;
}
afterEach(() => {
  axios.post = originalPost;
  for (const item of connectors.splice(0)) item.shutdown();
});

test('all venue execution surfaces expose account recovery contract', async () => {
  for (const venue of ['binance', 'kraken', 'okx', 'coinbase']) {
    const item = connector(venue);
    assert.ok(item.accountExecutionAdapter, `${venue} adapter`);
    assert.equal(item.accountExecutionAdapter.exchange, venue);
    assert.equal(typeof item.accountExecutionAdapter.listFills, 'function');
  }
});

test('native client order IDs are passed through unchanged on order submission', async () => {
  const requests: Array<{ url: string; data: any }> = [];
  axios.post = (async (url: string, data: any) => {
    requests.push({ url, data });
    if (url.includes('AddOrder')) return { data: { result: { txid: ['kraken-1'] }, error: [] } };
    if (url.includes('trade/order')) return { data: { code: '0', data: [{ ordId: 'okx-1', clOrdId: 'caller-id', state: 'live', sz: '1', accFillSz: '0' }] } };
    if (url.includes('brokerage/orders')) return { data: { success: true, order_id: 'cb-1', client_order_id: 'caller-id', status: 'OPEN' } };
    return { data: { orderId: 77, status: 'NEW', origQty: '1', executedQty: '0', transactTime: 123 } };
  }) as any;
  for (const venue of ['binance', 'kraken', 'okx', 'coinbase']) {
    const item = connector(venue);
    await item.accountExecutionAdapter.placeOrder({ clientOrderId: 'caller-id', symbol: 'BTC/USDT', side: 'buy', quantity: 1, orderType: 'market' });
  }
  const joined = requests.map(request => typeof request.data === 'string' ? request.data : JSON.stringify(request.data)).join('\n');
  assert.match(joined, /newClientOrderId=caller-id/);
  assert.match(joined, /cl_ord_id=caller-id/);
  assert.match(joined, /clOrdId.*caller-id/);
  assert.match(joined, /client_order_id.*caller-id/);
});

test('Coinbase Advanced Trade uses Bearer JWT and order_configuration', async () => {
  let headers: any;
  let body: any;
  axios.post = (async (_url: string, data: any, config: any) => {
    headers = config.headers;
    body = JSON.parse(data);
    return { data: { success: true, order_id: 'cb-1', status: 'OPEN' } };
  }) as any;
  const item = connector('coinbase');
  await item.accountExecutionAdapter.placeOrder({ clientOrderId: 'id-1', symbol: 'BTC/USDT', side: 'buy', quantity: 0.1, orderType: 'market' });
  assert.match(headers.Authorization, /^Bearer /);
  assert.equal(body.client_order_id, 'id-1');
  assert.ok(body.order_configuration.market_market_ioc);
  assert.equal(body.product_id, 'BTC-USDT');
});

test('venue API error payloads reject instead of becoming empty successful state', async () => {
  axios.get = (async () => ({ data: { code: '1001', msg: 'denied' } })) as any;
  const item = connector('okx');
  await assert.rejects(() => item.accountExecutionAdapter.getBalances(), /OKX API error/);
  axios.get = (async () => ({ data: { success: false, error_response: { message: 'denied' } } })) as any;
  const coinbase = connector('coinbase');
  await assert.rejects(() => coinbase.accountExecutionAdapter.getBalances(), /Coinbase API error/);
});
