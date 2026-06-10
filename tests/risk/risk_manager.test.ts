import { describe, test } from 'node:test';
import assert from 'node:assert';
import { RiskManager, RiskMode } from '../../backend/risk/manager.js';

describe('RiskManager branch coverage', () => {
  test('calculatePositionSize applies confidence clipping bounds', () => {
    const manager = new RiskManager();
    const low = manager.calculatePositionSize(10000, 50000, 49000, RiskMode.MODERATE, 10);
    const high = manager.calculatePositionSize(10000, 50000, 49000, RiskMode.MODERATE, 99);
    const base = manager.calculatePositionSize(10000, 50000, 49000, RiskMode.MODERATE, 75);

    assert.ok(low < base);
    assert.ok(high > base);
  });

  test('validateTrade enforces confidence, max positions, and active regime', () => {
    const manager = new RiskManager();
    const validSignal = { confidence: 95 };

    assert.strictEqual(manager.validateTrade({ confidence: 50 }, RiskMode.CONSERVATIVE, 0, 'strongbull'), false);
    assert.strictEqual(manager.validateTrade(validSignal, RiskMode.ULTRA_CONSERVATIVE, 1, 'strongbull'), false);
    assert.strictEqual(manager.validateTrade(validSignal, RiskMode.ULTRA_CONSERVATIVE, 0, 'bear'), false);
    assert.strictEqual(manager.validateTrade(validSignal, RiskMode.ULTRA_CONSERVATIVE, 0, 'strongbull'), true);
  });

  test('checkCircuitBreakers reports drawdown, daily loss, volatility, and consecutive-loss extremes', () => {
    const manager = new RiskManager();
    const mode = RiskMode.MODERATE;

    const drawdown = manager.checkCircuitBreakers(8000, 10000, 100, mode, 0, 0, 0);
    assert.ok(drawdown?.includes('Max drawdown reached'));

    const daily = manager.checkCircuitBreakers(10000, 10000, 600, mode, 0, 0, 0);
    assert.ok(daily?.includes('Max daily loss reached'));

    const losses = manager.checkCircuitBreakers(10000, 10000, 0, mode, 7, 0, 0);
    assert.ok(losses?.includes('Extreme consecutive losses'));

    const volatility = manager.checkCircuitBreakers(10000, 10000, 0, mode, 0, 4.2, 1.2);
    assert.ok(volatility?.includes('Volatility spike detected'));

    const ok = manager.checkCircuitBreakers(10000, 10000, 0, mode, 3, 1.1, 1.0);
    assert.strictEqual(ok, null);
  });
});
