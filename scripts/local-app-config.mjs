import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';

export function ensureLocalConfig(envPath, port, inheritedEnv = process.env) {
  let source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const values = parse(source);
  if (values.LIVE_TRADING_ENABLED === 'true' || inheritedEnv.LIVE_TRADING_ENABLED === 'true') {
    throw new Error('Disable LIVE_TRADING_ENABLED in .env and the shell before using the local app launcher.');
  }
  const credentials = {};
  for (const key of ['API_ADMIN_TOKEN', 'API_TRADER_TOKEN']) {
    const current = values[key];
    credentials[key] = current && !/^replace-me/i.test(current) ? current : randomBytes(32).toString('hex');
    if (credentials[key] !== current) {
      // Remove every definition so dotenv cannot select a later placeholder.
      source = source.replace(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'gm'), '');
      source = `${source.trimEnd()}${source.trim() ? '\n' : ''}${key}=${credentials[key]}\n`;
    }
  }
  const defaults = {
    HOST: '127.0.0.1', PORT: String(port), DB_PATH: 'trading_live.db',
    EXCHANGE_NAME: 'coingecko', EXCHANGE_USE_TESTNET: 'true',
    LIVE_TRADING_ENABLED: 'false', FREQTRADE_ENABLED: 'false',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in values)) source = `${source.trimEnd()}${source.trim() ? '\n' : ''}${key}=${value}\n`;
  }
  if (!existsSync(envPath) || source !== readFileSync(envPath, 'utf8')) {
    writeFileSync(envPath, source, { mode: 0o600 });
  }
  chmodSync(envPath, 0o600);
  return credentials;
}
