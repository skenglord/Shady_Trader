import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BackpressureManager } from '../../backend/exchange/backpressure.js';
import { MultiLevelCache } from '../../backend/exchange/cache.js';

describe('interval unref hygiene', () => {
  test('backpressure and cache cleanup intervals call unref', () => {
    const originalSetInterval = globalThis.setInterval;
    let unrefCalled = 0;
    const fakeInterval = {
      unref: () => {
        unrefCalled += 1;
        return fakeInterval;
      }
    };

    try {
      globalThis.setInterval = (() => fakeInterval) as unknown as typeof globalThis.setInterval;

      new BackpressureManager();
      new MultiLevelCache({} as any);

      assert.equal(unrefCalled, 2);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});
