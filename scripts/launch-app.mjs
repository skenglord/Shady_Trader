#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalConfig } from './local-app-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const port = Number(process.env.PORT || 3000);
const host = '127.0.0.1';

function runBuild() {
  console.log('\n[Shady Trader] Building the app…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Production build exited with status ${result.status}`);
}

function assertPortFree() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => reject(new Error(`Cannot bind ${host}:${port}: ${error.message}`)));
    probe.listen(port, host, () => probe.close(resolve));
  });
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
  browser.on('error', () => console.log(`[Shady Trader] Open this address in your browser: ${url}`));
  browser.unref();
}

async function waitUntilReady(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`App server exited early with status ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(`http://${host}:${port}/health/live`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The server may need a few seconds to initialize its database and routes.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill('SIGTERM');
  throw new Error(`App did not become ready at http://${host}:${port} within 30 seconds.`);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Use Node.js 22 (nvm use) to match the SQLite runtime.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const credentials = ensureLocalConfig(envPath, port);
  await assertPortFree();
  runBuild();

  const url = `http://${host}:${port}`;
  console.log('\n[Shady Trader] Local app is starting. Live exchange orders are disabled.');
  console.log(`[Shady Trader] URL: ${url}`);
  console.log('[Shady Trader] Enter these tokens at the authentication screen:');
  console.log(`  Admin token:  ${credentials.API_ADMIN_TOKEN}`);
  console.log(`  Trader token: ${credentials.API_TRADER_TOKEN}`);
  console.log('[Shady Trader] Install it from your browser’s app/install menu. Press Ctrl+C to stop.\n');

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: root,
    env: { ...process.env, ...credentials, NODE_ENV: 'production', HOST: host, PORT: String(port), LIVE_TRADING_ENABLED: 'false', FREQTRADE_ENABLED: 'false' },
    stdio: 'inherit',
  });
  const stop = (signal) => { if (!child.killed) child.kill(signal); };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  child.once('error', (error) => { console.error(`[Shady Trader] ${error.message}`); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
  });
  await waitUntilReady(child);
  console.log('[Shady Trader] App is ready.');
  openBrowser(url);
}

main().catch((error) => {
  console.error(`[Shady Trader] ${error.message}`);
  process.exitCode = 1;
});
