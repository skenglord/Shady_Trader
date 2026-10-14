import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { apiRouter } from '../../backend/api/routes.js';
import { setMockRunQuery, clearMockRunQuery } from '../../backend/database.js';

test('closed trade history reads the persisted price and handles database failure', async t => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trades (id TEXT, symbol TEXT, side TEXT, amount REAL, price REAL,
    status TEXT, timestamp INTEGER, risk_mode TEXT, pnl REAL, exit_price REAL, exit_timestamp INTEGER);
    INSERT INTO trades VALUES ('closed-1','BTC/USDT','buy',1,100,'closed',1,'moderate',2,102,2);`);
  const previous = process.env.API_TRADER_TOKEN;
  process.env.API_TRADER_TOKEN = 'closed-trades-test';
  t.after(() => { clearMockRunQuery(); db.close(); if (previous === undefined) delete process.env.API_TRADER_TOKEN; else process.env.API_TRADER_TOKEN = previous; });
  setMockRunQuery(async (sql, params = []) => db.prepare(sql).all(...params));
  const app = express(); app.use('/api', apiRouter);
  const response = await request(app).get('/api/trades/closed').set('x-api-token','closed-trades-test').timeout(1000);
  assert.equal(response.status, 200);
  assert.equal(response.body[0].entry_price, 100);
  assert.equal(response.body[0].strategy, null);
  setMockRunQuery(async () => { throw new Error('database unavailable'); });
  const unavailable = await request(app).get('/api/trades/closed').set('x-api-token','closed-trades-test').timeout(1000);
  assert.equal(unavailable.status, 503);
});
