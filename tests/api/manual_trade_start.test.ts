import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { WebSocketServer } from 'ws';
import { TradingEngine, startTradingEngine } from '../../backend/main.js';
import { apiRouter } from '../../backend/api/routes.js';
import { setMockRunQuery, clearMockRunQuery } from '../../backend/database.js';

test('manual entry after stop responds without waiting for the engine lifetime', async t => {
  process.env.API_TRADER_TOKEN = 'manual-start-test';
  t.mock.method(TradingEngine.prototype, 'init', async () => {});
  t.mock.method(TradingEngine.prototype, 'start', async () => {});
  setMockRunQuery(async () => []);
  const wss = new WebSocketServer({ noServer: true });
  const engine = await startTradingEngine(wss, { status: 'ready', on() {} } as any);
  let starts = 0;
  engine.start = () => { starts++; engine.isRunning = true; return new Promise<void>(() => {}); };
  engine.shadowTrader.processSignal = async () => true;
  t.after(() => { engine.paperTradingService.stop(); wss.close(); clearMockRunQuery(); });
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const response = await request(app).post('/api/manual-trade').set('x-api-token','manual-start-test')
    .send({ symbol: 'BTC/USDT', side: 'buy', price: 100, stopLoss: 99, takeProfit: 102 }).timeout(1000);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(starts, 1);
});
