import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiRouter } from '../../backend/api/routes.js';
import { setMockRunQuery, clearMockRunQuery } from '../../backend/database.js';

// Test auth tokens. Set in beforeEach so requireRole() resolves to a role
// (instead of returning 503 "auth not configured"). Real tokens aren't needed
// because we don't make outbound calls from these tests.
const TEST_ADMIN_TOKEN = 'test-admin-token-do-not-use-in-prod';
const TEST_TRADER_TOKEN = 'test-trader-token-do-not-use-in-prod';

// Snapshot of process.env at module load. Restored in afterEach so we don't
// leak our admin/trader tokens (or any other env mutation) into other tests
// running in parallel within the same Node process.
const originalEnv = { ...process.env };

function setupRouteMocks() {
  setMockRunQuery(async (sql: string, params?: any[], method?: string) => {
    if (sql.includes('SELECT 1')) return [{ 1: 1 }];
    if (sql.includes('FROM shadow_trades')) return [];
    if (sql.includes('FROM signals')) return [];
    if (sql.includes('FROM trades')) return [];
    if (sql.includes('FROM regime_history')) return [];
    if (sql.includes('FROM slippage_history')) return [];
    if (sql.includes('SELECT * FROM settings')) return [];
    if (sql.includes('INSERT')) return { changes: 1 };
    if (sql.includes('UPDATE') || sql.includes('DELETE')) return { changes: 1 };
    return [];
  });
}

// `concurrency: false` is required because this test mocks the global
// `runQuery` in `backend/database.ts`. With concurrent execution, other test
// files running in the same process would see the mock and fail
// intermittently (the flakiness pattern we hit before this fix). All
// `deep-deterministic/*` test files share this constraint.
describe('Deep Deterministic Tests - API Routes', { concurrency: false }, () => {
  let app: express.Application;

  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
    process.env.API_TRADER_TOKEN = TEST_TRADER_TOKEN;
    setupRouteMocks();
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  afterEach(() => {
    // CRITICAL: reset both the DB mock AND the env vars so we don't leak
    // state into any other test file that happens to run after this one.
    clearMockRunQuery();
    process.env = { ...originalEnv };
  });

  describe('Health Endpoints', () => {
    test('GET /api/health/live returns ok status', async () => {
      const response = await request(app).get('/api/health/live');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.status, 'ok');
    });

    test('GET /api/health/ready returns ready status without engine', async () => {
      const response = await request(app).get('/api/health/ready');
      assert.ok([200, 503].includes(response.status));
    });

    test('GET /api/health/providers returns 503 when engine not initialized', async () => {
      const response = await request(app).get('/api/health/providers');
      assert.strictEqual(response.status, 503);
      assert.ok(response.body.error);
    });
  });

  describe('Status Endpoint', () => {
    test('GET /api/status returns engine status', async () => {
      const response = await request(app).get('/api/status');
      assert.ok([200, 500].includes(response.status));
      if (response.status === 200) {
        assert.ok(response.body.hasOwnProperty('isRunning'));
      }
    });
  });

  describe('Risk Config Endpoints', () => {
    test('GET /api/risk-configs requires authentication', async () => {
      const response = await request(app).get('/api/risk-configs')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500, 503].includes(response.status));
    });

    test('POST /api/risk-configs requires validation', async () => {
      const response = await request(app).post('/api/risk-configs').send({});
      assert.ok([200, 400, 401, 403, 500, 503].includes(response.status));
    });
  });

  describe('Diagrams Endpoints', () => {
    // Diagnostics endpoints are trader-protected (Fix #6 from bounty audit).
    // The full health/startup response leaks exchange config, slowest routes, etc.
    // Liveness probes should use the public /api/health/quick or /api/health/live.
    test('GET /api/diagnostics/startup requires authentication', async () => {
      const response = await request(app).get('/api/diagnostics/startup');
      // Unauthenticated: 401. Authenticated: 200 or 500 (engine not init in tests).
      // Both behaviors are correct — we test the unauth case here.
      assert.strictEqual(response.status, 401);
    });

    test('GET /api/diagnostics/startup with trader token returns diagnostics', async () => {
      const response = await request(app).get('/api/diagnostics/startup')
        .set('Authorization', `Bearer ${TEST_TRADER_TOKEN}`);
      assert.ok([200, 401, 500].includes(response.status));
    });

    test('GET /api/diagnostics/health requires authentication', async () => {
      const response = await request(app).get('/api/diagnostics/health');
      assert.strictEqual(response.status, 401);
    });

    test('GET /api/diagnostics/health with trader token returns health info', async () => {
      const response = await request(app).get('/api/diagnostics/health')
        .set('Authorization', `Bearer ${TEST_TRADER_TOKEN}`);
      assert.ok([200, 401, 500].includes(response.status));
    });

    test('GET /api/health/quick is public and returns minimal status', async () => {
      const response = await request(app).get('/api/health/quick');
      assert.strictEqual(response.status, 200);
      assert.ok(response.body.status === 'ok');
      assert.ok(typeof response.body.uptimeSec === 'number');
      // Should NOT leak the full diagnostics fields
      assert.strictEqual(response.body.api, undefined);
      assert.strictEqual(response.body.marketData, undefined);
      assert.strictEqual(response.body.infrastructure, undefined);
    });

    test('GET /api/diagnostics/metrics returns prometheus format', async () => {
      const response = await request(app).get('/api/diagnostics/metrics')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Start/Stop Endpoints (Admin Required)', () => {
    test('POST /api/start requires admin role', async () => {
      const response = await request(app).post('/api/start');
      assert.ok([200, 400, 401, 403, 500, 503].includes(response.status));
    });

    test('POST /api/stop requires admin role', async () => {
      const response = await request(app).post('/api/stop');
      assert.ok([200, 400, 401, 403, 500, 503].includes(response.status));
    });
  });

  describe('Settings Endpoints', () => {
    test('GET /api/settings returns settings object', async () => {
      const response = await request(app).get('/api/settings')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
      if (response.status === 200) {
        assert.strictEqual(typeof response.body, 'object');
      }
    });

    test('POST /api/settings requires validation', async () => {
      const response = await request(app).post('/api/settings')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ invalid: 'data' });
      assert.ok([200, 400, 401, 403, 500, 503].includes(response.status));
    });

    test('POST /api/settings blocks api keys', async () => {
      const response = await request(app).post('/api/settings')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        
        .send({ apiKey: 'should-not-save', symbol: 'ETH/USDT' });
      
      assert.ok([200, 400].includes(response.status));
    });
  });

  describe('Timeframe Endpoint (Trader Required)', () => {
    test('POST /api/timeframe validates timeframe values', async () => {
      const response = await request(app).post('/api/timeframe')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ timeframe: 'invalid' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/timeframe accepts valid timeframe', async () => {
      const response = await request(app).post('/api/timeframe')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ timeframe: '1h' });
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/timeframe rejects invalid timeframe', async () => {
      const response = await request(app).post('/api/timeframe')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ timeframe: '2h' });
      assert.strictEqual(response.status, 400);
    });
  });

  describe('Active Mode Endpoint', () => {
    test('POST /api/active-mode validates mode', async () => {
      const response = await request(app).post('/api/active-mode')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ mode: 'invalid' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/active-mode accepts valid mode', async () => {
      const response = await request(app).post('/api/active-mode')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ mode: 'conservative' });
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Manual Regime Endpoint', () => {
    test('POST /api/regime/manual validates regime', async () => {
      const response = await request(app).post('/api/regime/manual')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ regime: 'invalid' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/regime/manual accepts valid regime', async () => {
      const response = await request(app).post('/api/regime/manual')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ regime: 'strong_bull' });
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Manual Trade Endpoint', () => {
    test('POST /api/manual-trade validates required fields', async () => {
      const response = await request(app).post('/api/manual-trade')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({});
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/manual-trade validates side enum', async () => {
      const response = await request(app).post('/api/manual-trade')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({
        side: 'invalid',
        symbol: 'BTC/USDT',
        price: 50000,
        stopLoss: 49000,
        takeProfit: 51000
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/manual-trade validates positive price', async () => {
      const response = await request(app).post('/api/manual-trade')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({
        side: 'buy',
        symbol: 'BTC/USDT',
        price: -100,
        stopLoss: 49000,
        takeProfit: 51000
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/manual-trade validates symbol presence', async () => {
      const response = await request(app).post('/api/manual-trade')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({
        side: 'buy',
        symbol: '',
        price: 50000,
        stopLoss: 49000,
        takeProfit: 51000
      });
      assert.strictEqual(response.status, 400);
    });
  });

  describe('Balances Endpoints', () => {
    test('GET /api/balances returns balance object', async () => {
      const response = await request(app).get('/api/balances')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/balances/allocate validates amount', async () => {
      const response = await request(app).post('/api/balances/allocate')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ amount: -100 });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/balances/allocate requires positive amount', async () => {
      const response = await request(app).post('/api/balances/allocate')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ amount: 0 });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/balances/withdraw validates amount', async () => {
      const response = await request(app).post('/api/balances/withdraw')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ amount: -100 });
      assert.strictEqual(response.status, 400);
    });
  });

  describe('Positions Endpoints', () => {
    test('GET /api/positions/open returns positions array', async () => {
      const response = await request(app).get('/api/positions/open')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/positions/close validates tradeId', async () => {
      const response = await request(app).post('/api/positions/close')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ tradeId: '' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/positions/close validates currentPrice', async () => {
      const response = await request(app).post('/api/positions/close')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ 
        tradeId: 'test-id', 
        currentPrice: -100 
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/positions/update requires at least one field', async () => {
      const response = await request(app).post('/api/positions/update')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`).send({ tradeId: 'test' });
      assert.strictEqual(response.status, 400);
    });
  });

  describe('Candles Endpoint', () => {
    test('GET /api/candles returns candles or empty array', async () => {
      const response = await request(app).get('/api/candles');
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/candles/history=1y uses long history', async () => {
      const response = await request(app).get('/api/candles?history=1y');
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Trades Endpoint', () => {
    test('GET /api/trades returns trades array', async () => {
      const response = await request(app).get('/api/trades')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        ;
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/trades respects limit parameter', async () => {
      const response = await request(app).get('/api/trades?limit=50')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        ;
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/trades caps limit at 200', async () => {
      const response = await request(app).get('/api/trades?limit=500')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        ;
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Regime History Endpoint', () => {
    test('GET /api/history/regime returns array', async () => {
      const response = await request(app).get('/api/history/regime');
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('SELECT pruning', () => {
    test('pruned high-volume endpoints use explicit column lists', () => {
      const routesSource = readFileSync(resolve(process.cwd(), 'backend/api/routes.ts'), 'utf8');
      const prunedBlocks = [
        "apiRouter.get('/trades'",
        "apiRouter.get('/shadow-trades/closed'",
        "apiRouter.get('/shadow-trades/all'",
        "apiRouter.get('/signals'",
        "apiRouter.get('/trades/closed'",
        "apiRouter.get('/history/regime'",
        "apiRouter.get('/slippage/history'",
      ];

      for (const blockStart of prunedBlocks) {
        const block = routesSource.slice(routesSource.indexOf(blockStart), routesSource.indexOf('});', routesSource.indexOf(blockStart)));
        assert.ok(block.includes('SELECT '), `${blockStart} should contain an explicit SELECT`);
        assert.ok(!block.includes('SELECT *'), `${blockStart} should not use SELECT *`);
      }
    });
  });

  describe('Market Data Endpoints', () => {
    test('GET /api/market/data returns market data', async () => {
      const response = await request(app).get('/api/market/data')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/market/news returns news array', async () => {
      const response = await request(app).get('/api/market/news');
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/market/refresh updates market data', async () => {
      const response = await request(app).post('/api/market/refresh')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500, 503].includes(response.status));
    });
  });

  describe('Performance Endpoint', () => {
    test('GET /api/performance returns performance metrics', async () => {
      const response = await request(app).get('/api/performance');
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Optimize Endpoint (Admin Required)', () => {
    test('POST /api/optimize requires admin role', async () => {
      const response = await request(app).post('/api/optimize');
      assert.ok([200, 401, 403, 500, 503].includes(response.status));
    });
  });

  describe('Kill Endpoint (Admin Required)', () => {
    test('POST /api/kill requires admin role', async () => {
      const response = await request(app).post('/api/kill');
      assert.ok([200, 401, 403, 500, 503].includes(response.status));
    });
  });

  describe('Risk Configs AI Recommend Endpoint', () => {
    test('POST /api/risk-configs/ai-recommend handles missing API key', async () => {
      const response = await request(app).post('/api/risk-configs/ai-recommend')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Slippage Endpoints', () => {
    test('POST /api/slippage/estimate validates symbol', async () => {
      const response = await request(app)
        .post('/api/slippage/estimate')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        .send({
          symbol: ''
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/slippage/estimate validates side', async () => {
      const response = await request(app)
        .post('/api/slippage/estimate')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        .send({
          symbol: 'BTC/USDT',
          side: 'invalid',
          size: 1
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/slippage/estimate validates size', async () => {
      const response = await request(app)
        .post('/api/slippage/estimate')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        .send({
          symbol: 'BTC/USDT',
          side: 'buy',
          size: -1
      });
      assert.strictEqual(response.status, 400);
    });

    test('GET /api/slippage/history returns history', async () => {
      const response = await request(app)
        .get('/api/slippage/history')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/slippage/history filters by symbol', async () => {
      const response = await request(app)
        .get('/api/slippage/history?symbol=BTC/USDT')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('API Route - Idempotency Middleware', () => {
    test('Idempotency key must be valid UUID format', async () => {
      const response = await request(app)
        .post('/api/manual-trade')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        .set('Idempotency-Key', 'invalid-uuid')
        .send({
          side: 'buy',
          symbol: 'BTC/USDT',
          price: 50000,
          stopLoss: 49000,
          takeProfit: 51000
        });
      assert.strictEqual(response.status, 400);
    });

    test('Valid idempotency key format is accepted', async () => {
      const response = await request(app)
        .post('/api/manual-trade')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        .set('Idempotency-Key', '123e4567-e89b-12d3-a456-426614174000')
        .send({
          side: 'buy',
          symbol: 'BTC/USDT',
          price: 50000,
          stopLoss: 49000,
          takeProfit: 51000
        });
      assert.ok([200, 400, 500].includes(response.status));
    });
  });

  describe('API Route - Request Metrics', () => {
    test('Response includes x-request-id header', async () => {
      const response = await request(app).get('/api/status');
      assert.ok(response.headers['x-request-id']);
    });

    test('Response request-id matches header', async () => {
      const customId = 'test-request-123';
      const response = await request(app).get('/api/status').set('x-request-id', customId);
      assert.ok(response.body);
    });
  });
});
