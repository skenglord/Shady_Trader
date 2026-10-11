import { test } from 'node:test';
import assert from 'node:assert/strict';

test('account identity is stable, non-secret, and isolated by venue, environment, and API key', async () => {
  const module = await import('../../backend/exchange/account-execution-adapter.js').catch(() => null);
  assert.ok(module, 'account execution contract module should be available');
  assert.equal(typeof module.getExchangeAccountId, 'function');

  const apiKey = 'public-key-value';
  const scope = module.getExchangeAccountId('binance', 'production', apiKey);
  assert.equal(scope, module.getExchangeAccountId('binance', 'production', apiKey));
  assert.notEqual(scope, apiKey);
  assert.equal(scope.includes(apiKey), false);
  assert.notEqual(scope, module.getExchangeAccountId('kraken', 'production', apiKey));
  assert.notEqual(scope, module.getExchangeAccountId('binance', 'testnet', apiKey));
  assert.notEqual(scope, module.getExchangeAccountId('binance', 'production', 'another-key'));
  assert.equal(module.getExchangeAccountId('binance', 'production', apiKey, 'primary'), 'binance:production:primary');
});
