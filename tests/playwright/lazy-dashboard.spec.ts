import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

// Serve only the production frontend. API and WebSocket traffic is mocked;
// this test never starts the engine or touches an operator's database.
let server: Server;
let baseUrl: string;
const root = resolve('dist');
// Service workers bypass Playwright's page routes. Keep API fixtures isolated.
test.use({ serviceWorkers: 'block' });
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try {
      const content = await readFile(file);
      const types: Record<string, string> = {
        '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
      };
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

for (const hasHistory of [false, true]) {
  test(`production dashboard lazy loads features with history=${hasHistory}`, async ({ page }) => {
    const chunks = new Set<string>();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('/assets/')) chunks.add(request.url());
    });
    const loaded = (name: string) => [...chunks].some(url => url.includes(`/${name}-`));
    await page.routeWebSocket('**/*', ws => ws.onMessage(() => ws.send(JSON.stringify({ type: 'auth_ok' }))));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const now = Date.now();
      const responses: Record<string, unknown> = {
        '/api/status': { isRunning: false, symbol: 'BTC/USDT', timeframe: '15m', currentRegime: 'ranging', exchange: 'coingecko' },
        '/api/performance': { moderate: { balance: 1000, roi: 0, winRate: 0, tradesCount: 0, history: hasHistory ? [{ time: now - 60000, balance: 990 }, { time: now, balance: 1000 }] : [] } },
        '/api/settings': {}, '/api/risk-configs': {}, '/api/balances': {},
        '/api/candles': [{ time: now - 60000, open: 100, high: 102, low: 99, close: 101 }, { time: now, open: 101, high: 103, low: 100, close: 102 }],
        '/api/market/data': { market_cap: 1e12, total_volume: 1e9, btc_dominance: 50, fear_greed_index: 50, fear_greed_value: 'Neutral' },
        '/api/freqtrade/info': { version: 'test', strategies: [], exchanges: [] },
        '/api/ml/status': { ml_enabled: false, models: [], confidence_threshold: '0.5' },
      };
      await route.fulfill({ json: responses[path] ?? [] });
    });

    await page.goto(baseUrl);
    await expect(page.getByRole('button', { name: /Enter Dashboard/i })).toBeVisible();
    expect(loaded('ChartPanel')).toBe(false);
    expect(loaded('PerformanceChart')).toBe(false);
    expect(loaded('MLDashboard')).toBe(false);
    expect(loaded('FreqtradePanel')).toBe(false);

    await page.locator('input[type="password"]').nth(0).fill('test-admin');
    await page.locator('input[type="password"]').nth(1).fill('test-trader');
    await page.getByRole('button', { name: /Enter Dashboard/i }).click();
    await expect(page.getByText('Live Market Data', { exact: true })).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();
    expect(loaded('ChartPanel')).toBe(true);
    if (hasHistory) {
      await expect(page.locator('.recharts-surface')).toBeVisible();
      expect(loaded('PerformanceChart')).toBe(true);
    } else {
      await expect(page.getByText('No performance data yet')).toBeVisible();
      expect(loaded('PerformanceChart')).toBe(false);
    }
    expect(loaded('MLDashboard')).toBe(false);
    expect(loaded('FreqtradePanel')).toBe(false);

    await page.getByRole('button', { name: 'Open ML monitoring dashboard' }).click();
    await expect(page.getByText('No trained models found.', { exact: false })).toBeVisible();
    expect(loaded('MLDashboard')).toBe(true);
    await page.getByRole('button', { name: 'Close ML dashboard' }).click();
    await page.getByRole('button', { name: 'Open Freqtrade sidecar' }).click();
    await expect(page.getByText('Freqtrade Sidecar', { exact: true })).toBeVisible();
    expect(loaded('FreqtradePanel')).toBe(true);
    expect(errors).toEqual([]);
  });
}
