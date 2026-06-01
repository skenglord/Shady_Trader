import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { validateModeForLive, enforceRiskCap } from '../../backend/risk/manager.js';

describe('Risk safety guards (Block 6)', () => {
  afterEach(() => { delete process.env.DEGEN_LIVE_OVERRIDE; });

  test('validateModeForLive throws for degen without override', () => {
    delete process.env.DEGEN_LIVE_OVERRIDE;
    assert.throws(() => validateModeForLive('degen'), /Degen mode is simulation-only/);
  });

  test('validateModeForLive does not throw for degen with override', () => {
    process.env.DEGEN_LIVE_OVERRIDE = 'true';
    assert.doesNotThrow(() => validateModeForLive('degen'));
  });

  test('validateModeForLive is a no-op for non-degen modes', () => {
    assert.doesNotThrow(() => validateModeForLive('conservative'));
    assert.doesNotThrow(() => validateModeForLive('moderate'));
  });

  test('enforceRiskCap caps oversized position (0.15,3,0.04 → effective 1.8% > 0.5%)', () => {
    const capped = enforceRiskCap(0.15, 3, 0.04);
    assert.ok(capped < 0.15, 'should be capped below original');
    // effective after cap should be ~0.005
    assert.ok(Math.abs(capped * 3 * 0.04 - 0.005) < 1e-9, 'effective risk equals cap');
  });

  test('enforceRiskCap leaves compliant size unchanged', () => {
    const size = enforceRiskCap(0.01, 1, 0.02); // effective 0.0002 < 0.005
    assert.equal(size, 0.01);
  });
});
