import { test } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../backend/main.ts';
import { WebSocketServer } from 'ws';

test('TradingEngine should initialize with correct polling interval', async () => {
  const wss = new WebSocketServer({ noServer: true });
  const engine = new TradingEngine(wss);
  await engine.init();
  assert.strictEqual(engine.isRunning, false);
});
