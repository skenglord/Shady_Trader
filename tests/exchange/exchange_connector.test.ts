import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { ExchangeConnector } from '../../backend/exchange/connector.js';
import { ExchangeAdapterFactory } from '../../backend/exchange/adapter.js';

const originalGet = axios.get;
const originalPost = axios.post;
const originalDelete = axios.delete;
const connectors: ExchangeConnector[] = [];

function makeConnector(exchange: string, key = '', secret = '') {
  const connector = new ExchangeConnector(exchange, key, secret, undefined, true);
  connector.shutdown();
  connectors.push(connector);
  return connector;
}

afterEach(() => {
  axios.get = originalGet;
  axios.post = originalPost;
  axios.delete = originalDelete;
  for (const connector of connectors.splice(0, connectors.length)) {
    connector.shutdown();
  }
});

describe('ExchangeConnector execution adapters', () => {
  test('rejects unsupported adapter providers at construction', async () => {
    // Data-only providers (coinmarketcap, coinapi, coingecko) don't need an
    // execution adapter and are accepted by the connector. The factory is
    // where unsupported exchanges are actually rejected, so we test it
    // directly to cover the real code path.
    assert.throws(
      () => ExchangeAdapterFactory.createAdapter('nonexistent' as any, '', ''),
      /Unsupported exchange/
    );
  });

  test('enforces Binance credentials for authenticated execution', async () => {
    const connector = makeConnector('binance');
    await assert.rejects(() => connector.placeOrder('BTC/USDT', 'buy', 0.1), /require[s]? EXCHANGE_API_KEY/);
    await assert.rejects(() => connector.getBalance(), /require[s]? EXCHANGE_API_KEY/);
    await assert.rejects(() => connector.cancelOrder('1', 'BTC/USDT'), /require[s]? EXCHANGE_API_KEY/);
  });

  test('parses Binance authenticated responses', async () => {
    axios.post = (async () => ({
      data: { orderId: 77, status: 'FILLED', executedQty: '0.25', price: '50123.45', transactTime: 1234567890 }
    })) as any;
    axios.get = (async () => ({
      data: { balances: [{ asset: 'USDT', free: '123.5' }, { asset: 'BTC', free: '0' }] }
    })) as any;
    axios.delete = (async () => ({})) as any;

    const connector = makeConnector('binance', 'k', 's');
    const order = await connector.placeOrder('BTC/USDT', 'buy', 0.25);
    assert.strictEqual(order.simulated, false);
    assert.strictEqual(order.exchange, 'binance');
    assert.strictEqual(order.id, '77');

    const balance = await connector.getBalance();
    assert.strictEqual(balance.simulated, false);
    assert.strictEqual(balance.USDT, 123.5);

    const cancelled = await connector.cancelOrder('77', 'BTC/USDT');
    assert.strictEqual(cancelled, true);
  });

  test('supports Kraken authenticated execution adapter paths', async () => {
    axios.post = (async (url: string) => {
      if (url.includes('/AddOrder')) return { data: { result: { txid: ['tx-1'] }, error: [] } };
      if (url.includes('/Balance')) return { data: { result: { ZUSD: '42.10', XXBT: '0.001' } } };
      if (url.includes('/CancelOrder')) return { data: { result: { count: 1 } } };
      return { data: {} };
    }) as any;

    const connector = makeConnector('kraken', 'k', 'czVjcmV0'); // base64-like secret
    const capabilities = connector.getCapabilities();
    assert.strictEqual(capabilities.provider, 'kraken');
    assert.strictEqual(capabilities.supportsLiveTrading, true);

    const order = await connector.placeOrder('BTC/USDT', 'sell', 0.15);
    assert.strictEqual(order.exchange, 'kraken');
    assert.strictEqual(order.id, 'tx-1');
    assert.strictEqual(order.simulated, false);

    const balance = await connector.getBalance();
    assert.strictEqual(balance.simulated, false);
    assert.strictEqual(balance.ZUSD, 42.1);

    const cancelled = await connector.cancelOrder('tx-1', 'BTC/USDT');
    assert.strictEqual(cancelled, true);
  });
});
