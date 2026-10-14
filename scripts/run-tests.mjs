import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = join(directory, entry.name);
    return entry.isDirectory() ? discover(name) : entry.name.endsWith('.test.ts') ? [name] : [];
  });
}

const files = process.argv.slice(2);
const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', '--test-timeout=120000',
  ...(files.length ? files : discover('tests').sort())], { stdio: 'inherit', env: { ...process.env,
    NODE_ENV: 'test', REDIS_HOST: '127.0.0.1', REDIS_PORT: '1', FREQTRADE_LOCAL_JOBS: 'false',
    FREQTRADE_ENABLED: 'false', ML_ENABLED: 'false', LIVE_TRADING_ENABLED: 'false' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
