import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../backend/main.js';

test('cycle broadcasts resolved portfolio data and retains it across a failed refresh', async () => {
  const snapshot = { moderate: { balance: 100000, roi: 0, tradesCount: 0, history: [] } };
  const frames: any[] = [];
  const engine: any = Object.create(TradingEngine.prototype);
  engine.shadowTrader = { getPerformance: async () => snapshot };
  engine.balanceManager = { getBalances: async () => ({ botBalance: 100000 }) };
  engine.abortCycleIfNeeded = () => false;
  engine.broadcast = (frame: unknown) => frames.push(JSON.parse(JSON.stringify(frame)));
  await engine.broadcastCycleStage({ cycleToken: 1, symbol: 'BTC/USDT' }, { df: [] });
  assert.deepEqual(frames.find(f => f.type === 'performance').data, snapshot);

  frames.length = 0;
  engine.shadowTrader.getPerformance = async () => { throw new Error('temporary database failure'); };
  await engine.broadcastCycleStage({ cycleToken: 1, symbol: 'BTC/USDT' }, { df: [] });
  assert.deepEqual(frames.find(f => f.type === 'performance').data.moderate, snapshot.moderate);
});
