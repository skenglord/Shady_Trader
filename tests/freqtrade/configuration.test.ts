import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const config = JSON.parse(readFileSync(resolve(root, 'backend/freqtrade/user_data/config.json'), 'utf8'));
const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
const requirements = readFileSync(resolve(root, 'backend/freqtrade/requirements.txt'), 'utf8');

describe('Freqtrade deployment configuration', () => {
  test('keeps the reference trader safe while enabling futures backtesting', () => {
    assert.equal(config.dry_run, true);
    assert.equal(config.initial_state, 'stopped');
    assert.equal(config.trading_mode, 'futures');
    assert.equal(config.margin_mode, 'isolated');
    assert.equal(config.force_entry_enable, false);
    assert.equal(config.api_server.enabled, true);
    assert.equal(config.api_server.listen_ip_address, '127.0.0.1');
    assert.deepEqual(config.exchange.pair_whitelist, [
      'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'
    ]);
    assert.equal(config.pairlists[0].method, 'StaticPairList');
  });

  test('builds the CLI runtime into the app image with compatible strategy dependencies', () => {
    assert.match(dockerfile, /python3-venv/);
    assert.match(dockerfile, /pip install[^\n]*requirements\.txt/);
    assert.match(dockerfile, /COPY --from=deps[^\n]*backend\/freqtrade\/venv/);
    assert.match(requirements, /^freqtrade\[plotting\]==\d/m);
    assert.match(requirements, /^pandas_ta==/m);
    assert.match(requirements, /^numpy>2,<3$/m);
  });

  test('compose shares the CLI runtime and candle data with a private API sidecar', () => {
    assert.match(compose, /FREQTRADE_ENABLED: \$\{FREQTRADE_ENABLED:-false\}/);
    assert.match(compose, /profiles: \["freqtrade"\]/);
    assert.match(compose, /command: bash backend\/freqtrade\/run_webserver\.sh/);
    assert.equal((compose.match(/freqtrade_venv:\/app\/backend\/freqtrade\/venv/g) || []).length, 2);
    assert.equal((compose.match(/freqtrade_data:\/app\/backend\/freqtrade\/user_data\/data/g) || []).length, 2);
    assert.match(compose, /127\.0\.0\.1:\$\{FREQTRADE_LISTEN_PORT:-8081\}:8081/);
    assert.match(compose, /FREQTRADE__API_SERVER__LISTEN_IP_ADDRESS: 0\.0\.0\.0/);
  });
});
