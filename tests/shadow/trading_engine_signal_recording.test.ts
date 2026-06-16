import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('TradingEngine signal recording source', () => {
  test('has one signal INSERT block in runCycle', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'backend/main.ts'), 'utf8');
    const runCycleSource = mainSource.slice(mainSource.indexOf('async runCycle()'), mainSource.indexOf('broadcast(message'));
    const insertCount = (runCycleSource.match(/INSERT INTO signals/g) || []).length;
    const signalRecordBroadcastCount = (runCycleSource.match(/type: 'signal_record'/g) || []).length;

    assert.strictEqual(insertCount, 1, 'runCycle should insert signals exactly once per cycle');
    assert.strictEqual(signalRecordBroadcastCount, 1, 'runCycle should broadcast signal_record exactly once per cycle');
  });
});
