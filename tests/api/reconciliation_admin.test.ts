import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { apiRouter } from '../../backend/api/routes.js';

const env = { admin: process.env.API_ADMIN_TOKEN, trader: process.env.API_TRADER_TOKEN, node: process.env.NODE_ENV };
function app() { const instance = express(); instance.use(express.json()); instance.use('/api', apiRouter); return instance; }
beforeEach(() => { process.env.API_ADMIN_TOKEN = 'admin-test'; process.env.API_TRADER_TOKEN = 'trader-test'; process.env.NODE_ENV = 'test'; });
afterEach(() => { if (env.admin === undefined) delete process.env.API_ADMIN_TOKEN; else process.env.API_ADMIN_TOKEN = env.admin; if (env.trader === undefined) delete process.env.API_TRADER_TOKEN; else process.env.API_TRADER_TOKEN = env.trader; if (env.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.node; });

test('incident listing is admin-only', async () => {
  assert.equal((await request(app()).get('/api/reconciliation/incidents')).status, 401);
  assert.equal((await request(app()).get('/api/reconciliation/incidents').set('x-api-token', 'trader-test')).status, 403);
  assert.equal((await request(app()).get('/api/reconciliation/incidents').set('x-api-token', 'admin-test')).status, 503);
});

test('incident resolution requires an admin and a nonempty reason', async () => {
  assert.equal((await request(app()).post('/api/reconciliation/incidents/id/resolve').set('x-api-token', 'trader-test').send({ reason: 'reviewed' })).status, 403);
  assert.equal((await request(app()).post('/api/reconciliation/incidents/id/resolve').set('x-api-token', 'admin-test').send({ reason: '  ' })).status, 400);
});
