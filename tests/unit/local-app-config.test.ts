import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { ensureLocalConfig } from '../../scripts/local-app-config.mjs';

function fixture(t: { after: (fn: () => void) => void }, source = '') {
  const dir = mkdtempSync(join(tmpdir(), 'shady-app-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  writeFileSync(file, source);
  return file;
}

test('local launcher preserves dotenv quoted and exported credentials', (t) => {
  const file = fixture(t, 'export API_ADMIN_TOKEN="admin#secret" # comment\nAPI_TRADER_TOKEN=trader-secret # comment\n');
  const credentials = ensureLocalConfig(file, 3000, { API_ADMIN_TOKEN: 'shell-admin' });
  assert.deepEqual(credentials, { API_ADMIN_TOKEN: 'admin#secret', API_TRADER_TOKEN: 'trader-secret' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(parse(readFileSync(file, 'utf8')).LIVE_TRADING_ENABLED, 'false');
});

test('local launcher replaces duplicate placeholders and reuses generated tokens', (t) => {
  const file = fixture(t, 'API_ADMIN_TOKEN=replace-me\nexport API_ADMIN_TOKEN="replace-me-again"\nAPI_TRADER_TOKEN=\n');
  const credentials = ensureLocalConfig(file, 3000, {});
  const parsed = parse(readFileSync(file, 'utf8'));
  for (const key of ['API_ADMIN_TOKEN', 'API_TRADER_TOKEN'] as const) {
    assert.match(credentials[key], /^[a-f0-9]{64}$/);
    assert.equal(parsed[key], credentials[key]);
  }
  assert.notEqual(credentials.API_ADMIN_TOKEN, credentials.API_TRADER_TOKEN);
  assert.deepEqual(ensureLocalConfig(file, 3000, {}), credentials);
});

test('local launcher refuses live mode before changing the configuration', (t) => {
  for (const [source, shell] of [
    ['LIVE_TRADING_ENABLED=true\n', {}],
    ['LIVE_TRADING_ENABLED=false\n', { LIVE_TRADING_ENABLED: 'true' }],
  ] as const) {
    const file = fixture(t, source);
    assert.throws(() => ensureLocalConfig(file, 3000, shell), /Disable LIVE_TRADING_ENABLED/);
    assert.equal(readFileSync(file, 'utf8'), source);
  }
});
