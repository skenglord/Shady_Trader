import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('TradingEngine signal recording source', () => {
  test('has one signal INSERT block in runCycle', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'backend/main.ts'), 'utf8');
    // runCycle() was decomposed (T4) into typed stage methods that it orchestrates
    // linearly. The signal INSERT and signal_record broadcast now live in the
    // persistSignalRecord / broadcastSignalRecord stage helpers, which runCycle
    // calls exactly once per cycle via generateSignalsStage. To verify the
    // "exactly one insert / one signal_record per cycle" invariant structurally,
    // scan the stage region — from the first private stage method through the
    // broadcast(message) method that follows runCycle — rather than only the
    // runCycle body slice.
    const stageStart = mainSource.indexOf('private async fetchMarketData(');
    const scanStart = stageStart !== -1 ? stageStart : mainSource.indexOf('async runCycle()');
    const scanEnd = mainSource.indexOf('broadcast(message');
    const runCycleSource = mainSource.slice(scanStart, scanEnd);
    const insertCount = (runCycleSource.match(/INSERT INTO signals/g) || []).length;
    const signalRecordBroadcastCount = (runCycleSource.match(/type: 'signal_record'/g) || []).length;

    assert.strictEqual(insertCount, 1, 'runCycle should insert signals exactly once per cycle');
    assert.strictEqual(signalRecordBroadcastCount, 1, 'runCycle should broadcast signal_record exactly once per cycle');
  });
});
