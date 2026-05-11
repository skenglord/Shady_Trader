import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { apiRouter } from '../../backend/api/routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

const originalEnv = { ...process.env };

describe('API auth and validation matrix', () => {
  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = 'admin-token';
    process.env.API_TRADER_TOKEN = 'trader-token';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns 401 when token is missing for protected route', async () => {
    const res = await request(createApp()).post('/api/start').send({});
    assert.strictEqual(res.status, 401);
  });

  test('returns 403 when trader token calls admin route', async () => {
    const res = await request(createApp())
      .post('/api/start')
      .set('Authorization', 'Bearer trader-token')
      .send({});

    assert.strictEqual(res.status, 403);
  });

  test('returns 503 in production when auth is not configured', async () => {
    delete process.env.API_ADMIN_TOKEN;
    delete process.env.API_TRADER_TOKEN;
    delete process.env.API_AUTH_TOKEN;
    process.env.NODE_ENV = 'production';

    const res = await request(createApp()).post('/api/start').send({});
    assert.strictEqual(res.status, 503);
  });

  test('returns 400 for invalid payload with valid trader token', async () => {
    const res = await request(createApp())
      .post('/api/manual-trade')
      .set('x-api-token', 'trader-token')
      .send({ side: 'buy', symbol: '', price: -1, stopLoss: 0, takeProfit: 0 });

    assert.strictEqual(res.status, 400);
  });

  test('propagates request correlation ID header', async () => {
    const res = await request(createApp())
      .get('/api/status')
      .set('x-request-id', 'req-12345');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['x-request-id'], 'req-12345');
  });
});
