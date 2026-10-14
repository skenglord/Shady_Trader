import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { PaperTradingService } from '../../backend/paper-trading/paper-trading-service.js';
import router from '../../backend/paper-trading/paper-trading.controller.js';
import { PaperTradingWebSocketHandler } from '../../backend/paper-trading/websocket-handler.js';

test('REST create, fill, close and WS summaries use the registered engine account', async t => {
  const registry = await import('../../backend/paper-trading/service-registry.js');
  const service = new PaperTradingService(() => ({ async getOrderBook(symbol) {
    return { symbol, timestamp: Date.now(), bids: [[99, 5]], asks: [[100, 5]] };
  } }));
  registry.registerPaperTradingService(service);
  const handler = new PaperTradingWebSocketHandler(service);
  t.after(() => { handler.stopUpdates(); service.stop(); registry.registerPaperTradingService(null); });
  const app = express().use(express.json()).use('/paper', router);
  const body = { symbol: 'BTC/USDT', side: 'buy', type: 'market', quantity: 1, timeInForce: 'IOC', idempotencyKey: 'rest-entry' };
  const entry = await request(app).post('/paper/order').send(body).expect(200);
  const retry = await request(app).post('/paper/order').send(body).expect(200);
  assert.equal(retry.body.id, entry.body.id);
  assert.equal(entry.body.status, 'filled');
  const detail = await request(app).get(`/paper/order/${entry.body.id}`).expect(200);
  assert.equal(detail.body.filledQuantity, '1');
  const positions = await request(app).get('/paper/positions').expect(200);
  assert.equal(positions.body[0].id, entry.body.id);
  class Socket extends EventEmitter { readyState = 1; sent: any[] = []; send(value: string) { this.sent.push(JSON.parse(value)); } }
  const socket = new Socket();
  handler.handleConnection(socket as any, 'account-test');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(socket.sent.find(m => m.type === 'paper_position_update').data.positions[0].id, entry.body.id);
  await request(app).put(`/paper/positions/${entry.body.id}/close`).send({ idempotencyKey: 'rest-close' }).expect(200);
  await request(app).put(`/paper/positions/${entry.body.id}/close`).send({ idempotencyKey: 'rest-close' }).expect(200);
  const summary = await request(app).get('/paper/summary').expect(200);
  assert.equal(summary.body.positionCount.open, 0);
  assert.equal(summary.body.positionCount.closed, 1);
  assert.equal(summary.body.totalRealizedPnl, '-1');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(socket.sent.filter(m => m.type === 'paper_pnl_update').at(-1).data.totalRealizedPnl, '-1');
});

test('paper REST reports unavailable ownership as a service outage', async () => {
  const app = express().use('/paper', router);
  await request(app).get('/paper/summary').expect(503);
});
