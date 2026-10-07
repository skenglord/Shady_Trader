import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { validateModeForLive, enforceDegenDollarCap, enforceRiskCap, getDailyRealizedLoss } from '../../backend/risk/manager.js';
import { clearMockRunQuery, setMockRunQuery } from '../../backend/database.js';

describe('Risk safety guards (Block 6)', () => {
  afterEach(() => {
    delete process.env.DEGEN_LIVE_OVERRIDE;
    delete process.env.MAX_EFFECTIVE_RISK_FRACTION;
    delete process.env.DEGEN_MAX_RISK_DOLLARS;
    clearMockRunQuery();
  });

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

  test('enforceRiskCap fails closed on invalid cap configuration', () => {
    process.env.MAX_EFFECTIVE_RISK_FRACTION = 'NaN';
    assert.throws(() => enforceRiskCap(0.1, 1, 0.02), /Invalid inputs/);
  });

  test('degen dollar cap includes leverage in dollar risk', () => {
    process.env.DEGEN_MAX_RISK_DOLLARS = '500';
    const capped = enforceDegenDollarCap('degen', 0.15, 100000, 0.04, 3);
    assert.ok(Math.abs(capped * 100000 * 0.04 * 3 - 500) < 1e-8);
  });

  test('daily realized loss is net loss from the start of UTC day', async () => {
    let observedStart = 0;
    setMockRunQuery(async (sql, params = []) => {
      assert.match(sql, /SUM\(pnl\)/);
      observedStart = Number(params[1]);
      return [{ netPnl: -125.5 }];
    });
    const now = Date.UTC(2026, 8, 30, 15, 20);
    assert.equal(await getDailyRealizedLoss('moderate', now), 125.5);
    assert.equal(observedStart, Date.UTC(2026, 8, 30));
  });

  test('daily loss includes unrealized losses on open positions', async () => {
    setMockRunQuery(async (sql: string) => {
      if (sql.includes('SUM(pnl)')) return [{ netPnl: -100 }];
      if (sql.includes("status = 'open'")) return [{ side: 'buy', amount: 2, price: 50 }];
      return [];
    });
    assert.equal(await getDailyRealizedLoss('moderate', Date.UTC(2026, 8, 30), 40), 120);
  });
});
