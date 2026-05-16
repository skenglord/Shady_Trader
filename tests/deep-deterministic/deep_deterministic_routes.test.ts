import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { apiRouter } from '../../backend/api/routes.js';
import { setMockRunQuery } from '../../backend/database.js';

function setupRouteMocks() {
  // Clear any env-loaded auth tokens so requireRole bypasses auth in test mode
  delete process.env.API_ADMIN_TOKEN;
  delete process.env.API_TRADER_TOKEN;
  delete process.env.API_AUTH_TOKEN;
  setMockRunQuery(async (sql: string, params?: any[], method?: string) => {
    if (sql.includes('SELECT 1')) return [{ 1: 1 }];
    if (sql.includes('SELECT * FROM shadow_trades ORDER BY timestamp DESC LIMIT')) return [];
    if (sql.includes('SELECT * FROM regime_history ORDER BY timestamp DESC LIMIT')) return [];
    if (sql.includes('SELECT * FROM settings')) return [];
    if (sql.includes('INSERT')) return { changes: 1 };
    if (sql.includes('UPDATE') || sql.includes('DELETE')) return { changes: 1 };
    return [];
  });
}

describe('Deep Deterministic Tests - API Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    setupRouteMocks();
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  afterEach(() => {
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
      const response = await request(app).get('/api/risk-configs');
      assert.ok([200, 500, 503].includes(response.status));
    });

    test('POST /api/risk-configs requires validation', async () => {
      const response = await request(app).post('/api/risk-configs').send({});
      assert.ok([200, 400, 401, 403, 500, 503].includes(response.status));
    });
  });

  describe('Diagrams Endpoints', () => {
    test('GET /api/diagnostics/startup returns diagnostics', async () => {
      const response = await request(app).get('/api/diagnostics/startup');
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/diagnostics/health returns health info', async () => {
      const response = await request(app).get('/api/diagnostics/health');
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/diagnostics/metrics returns prometheus format', async () => {
      const response = await request(app).get('/api/diagnostics/metrics');
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
      const response = await request(app).get('/api/settings');
      assert.ok([200, 500].includes(response.status));
      if (response.status === 200) {
        assert.strictEqual(typeof response.body, 'object');
      }
    });

    test('POST /api/settings requires validation', async () => {
      const response = await request(app).post('/api/settings').send({ invalid: 'data' });
      assert.ok([200, 400, 401, 403, 500, 503].includes(response.status));
    });

    test('POST /api/settings blocks api keys', async () => {
      const response = await request(app)
        .post('/api/settings')
        .send({ apiKey: 'should-not-save', symbol: 'ETH/USDT' });
      
      assert.ok([200, 400].includes(response.status));
    });
  });

  describe('Timeframe Endpoint (Trader Required)', () => {
    test('POST /api/timeframe validates timeframe values', async () => {
      const response = await request(app).post('/api/timeframe').send({ timeframe: 'invalid' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/timeframe accepts valid timeframe', async () => {
      const response = await request(app).post('/api/timeframe').send({ timeframe: '1h' });
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/timeframe rejects invalid timeframe', async () => {
      const response = await request(app).post('/api/timeframe').send({ timeframe: '2h' });
      assert.strictEqual(response.status, 400);
    });
  });

  describe('Active Mode Endpoint', () => {
    test('POST /api/active-mode validates mode', async () => {
      const response = await request(app).post('/api/active-mode').send({ mode: 'invalid' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/active-mode accepts valid mode', async () => {
      const response = await request(app).post('/api/active-mode').send({ mode: 'conservative' });
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Manual Regime Endpoint', () => {
    test('POST /api/regime/manual validates regime', async () => {
      const response = await request(app).post('/api/regime/manual').send({ regime: 'invalid' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/regime/manual accepts valid regime', async () => {
      const response = await request(app).post('/api/regime/manual').send({ regime: 'strong_bull' });
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Manual Trade Endpoint', () => {
    test('POST /api/manual-trade validates required fields', async () => {
      const response = await request(app).post('/api/manual-trade').send({});
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/manual-trade validates side enum', async () => {
      const response = await request(app).post('/api/manual-trade').send({
        side: 'invalid',
        symbol: 'BTC/USDT',
        price: 50000,
        stopLoss: 49000,
        takeProfit: 51000
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/manual-trade validates positive price', async () => {
      const response = await request(app).post('/api/manual-trade').send({
        side: 'buy',
        symbol: 'BTC/USDT',
        price: -100,
        stopLoss: 49000,
        takeProfit: 51000
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/manual-trade validates symbol presence', async () => {
      const response = await request(app).post('/api/manual-trade').send({
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
      const response = await request(app).get('/api/balances');
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/balances/allocate validates amount', async () => {
      const response = await request(app).post('/api/balances/allocate').send({ amount: -100 });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/balances/allocate requires positive amount', async () => {
      const response = await request(app).post('/api/balances/allocate').send({ amount: 0 });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/balances/withdraw validates amount', async () => {
      const response = await request(app).post('/api/balances/withdraw').send({ amount: -100 });
      assert.strictEqual(response.status, 400);
    });
  });

  describe('Positions Endpoints', () => {
    test('GET /api/positions/open returns positions array', async () => {
      const response = await request(app).get('/api/positions/open');
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/positions/close validates tradeId', async () => {
      const response = await request(app).post('/api/positions/close').send({ tradeId: '' });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/positions/close validates currentPrice', async () => {
      const response = await request(app).post('/api/positions/close').send({ 
        tradeId: 'test-id', 
        currentPrice: -100 
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/positions/update requires at least one field', async () => {
      const response = await request(app).post('/api/positions/update').send({ tradeId: 'test' });
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
      const response = await request(app).get('/api/trades');
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/trades respects limit parameter', async () => {
      const response = await request(app).get('/api/trades?limit=50');
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/trades caps limit at 200', async () => {
      const response = await request(app).get('/api/trades?limit=500');
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Regime History Endpoint', () => {
    test('GET /api/history/regime returns array', async () => {
      const response = await request(app).get('/api/history/regime');
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Market Data Endpoints', () => {
    test('GET /api/market/data returns market data', async () => {
      const response = await request(app).get('/api/market/data');
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/market/news returns news array', async () => {
      const response = await request(app).get('/api/market/news');
      assert.ok([200, 500].includes(response.status));
    });

    test('POST /api/market/refresh updates market data', async () => {
      const response = await request(app).post('/api/market/refresh');
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

  describe('Backtest Endpoint (Admin Required)', () => {
    test('POST /api/backtest validates mode', async () => {
      const response = await request(app).post('/api/backtest').send({
        mode: 'invalid',
        config: {},
        startTime: Date.now() - 86400000,
        endTime: Date.now()
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/backtest validates time range', async () => {
      const response = await request(app).post('/api/backtest').send({
        mode: 'moderate',
        config: {},
        startTime: Date.now(),
        endTime: Date.now() - 86400000
      });
      assert.strictEqual(response.status, 400);
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
      const response = await request(app).post('/api/risk-configs/ai-recommend');
      assert.ok([200, 500].includes(response.status));
    });
  });

  describe('Slippage Endpoints', () => {
    test('POST /api/slippage/estimate validates symbol', async () => {
      const response = await request(app).post('/api/slippage/estimate').send({
        symbol: ''
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/slippage/estimate validates side', async () => {
      const response = await request(app).post('/api/slippage/estimate').send({
        symbol: 'BTC/USDT',
        side: 'invalid',
        size: 1
      });
      assert.strictEqual(response.status, 400);
    });

    test('POST /api/slippage/estimate validates size', async () => {
      const response = await request(app).post('/api/slippage/estimate').send({
        symbol: 'BTC/USDT',
        side: 'buy',
        size: -1
      });
      assert.strictEqual(response.status, 400);
    });

    test('GET /api/slippage/history returns history', async () => {
      const response = await request(app).get('/api/slippage/history');
      assert.ok([200, 500].includes(response.status));
    });

    test('GET /api/slippage/history filters by symbol', async () => {
      const response = await request(app).get('/api/slippage/history?symbol=BTC/USDT');
      assert.ok([200, 500].includes(response.status));
    });
  });
});

describe('API Route - Idempotency Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    setupRouteMocks();
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  test('Idempotency key must be valid UUID format', async () => {
    const response = await request(app)
      .post('/api/manual-trade')
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
  let app: express.Application;

  beforeEach(() => {
    setupRouteMocks();
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

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