import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREQTRADE_MAX_TIMERANGE_DAYS,
  buildFreqtradeEnv,
  normalizeFreqtradeTimerange,
  normalizeValidateTolerance,
  resolveFreqtradeApiEnv,
} from '../../backend/freqtrade/validation.js';

const originalEnv = { ...process.env };

describe('Freqtrade validation helpers', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  test('normalizes ISO and Freqtrade timeranges within the 365-day cap', () => {
    assert.deepStrictEqual(normalizeFreqtradeTimerange({ start: '2024-01-01', end: '20240102' }), {
      start: '20240101',
      end: '20240102',
    });

    assert.throws(
      () => normalizeFreqtradeTimerange({ start: '2024-01-01', end: '2026-01-02' }),
      /cannot exceed/,
    );
    assert.throws(
      () => normalizeFreqtradeTimerange({ start: '2025-02-31', end: '2025-03-01' }),
      /YYYYMMDD/,
    );
  });

  test('normalizes validation tolerance to a bounded number', () => {
    assert.strictEqual(normalizeValidateTolerance('0.1'), 0.1);
    assert.throws(() => normalizeValidateTolerance('bad'), /between 0 and 1/);
    assert.throws(() => normalizeValidateTolerance(1.1), /between 0 and 1/);
  });

  test('requires Freqtrade API credentials without predictable fallbacks', () => {
    process.env = { ...originalEnv };
    delete process.env.FREQTRADE_API_USER;
    delete process.env.FREQTRADE_API_PASS;
    delete process.env.FREQTRADE__API_SERVER__USERNAME;
    delete process.env.FREQTRADE__API_SERVER__PASSWORD;

    assert.throws(() => resolveFreqtradeApiEnv(), /FREQTRADE_API_USER/);
    assert.throws(() => buildFreqtradeEnv(), /FREQTRADE_API_USER/);
  });

  test('builds Freqtrade env with generated JWT secret', () => {
    process.env = {
      ...originalEnv,
      FREQTRADE_API_USER: 'test-user',
      FREQTRADE_API_PASS: 'test-pass',
      FREQTRADE__API_SERVER__JWT_SECRET_KEY: 'fixed-secret',
    };

    const env = buildFreqtradeEnv();
    assert.strictEqual(env.FREQTRADE__API_SERVER__USERNAME, 'test-user');
    assert.strictEqual(env.FREQTRADE__API_SERVER__PASSWORD, 'test-pass');
    assert.strictEqual(env.FREQTRADE__API_SERVER__JWT_SECRET_KEY, 'fixed-secret');
  });

  test('exports the shared max timerange constant', () => {
    assert.strictEqual(FREQTRADE_MAX_TIMERANGE_DAYS, 365);
  });
});
