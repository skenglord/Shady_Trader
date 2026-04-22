import { describe, test } from 'node:test';
import assert from 'node:assert';
import { getRequestId } from '../backend/logging/logger.js';

describe('logger helpers', () => {
  test('getRequestId handles string arrays and falls back when array is empty', () => {
    assert.strictEqual(getRequestId(['req-array']), 'req-array');
    const generated = getRequestId([]);
    assert.strictEqual(typeof generated, 'string');
    assert.ok(generated.length > 0);
  });
});
