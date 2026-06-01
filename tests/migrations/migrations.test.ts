import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { initDatabase, runQuery } from '../../backend/database.js';
import { runMigrations } from '../../backend/migrations/runner.js';

describe('v6.0 Migrations', () => {
  before(async () => {
    await initDatabase();
  });

  test('runMigrations is idempotent (runs twice without error)', async () => {
    await runMigrations();
    await runMigrations(); // second run must not throw
    assert.ok(true);
  });

  test('all four new tables exist', async () => {
    const tables = ['regimes_v2', 'ml_models', 'ml_predictions', 'vpi_history'];
    for (const t of tables) {
      const rows = await runQuery(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [t], 'all'
      );
      assert.equal((rows as any[]).length, 1, `table ${t} should exist`);
    }
  });

  test('regime_history has no underscore regime values after migration', async () => {
    const rows = await runQuery(
      `SELECT DISTINCT regime FROM regime_history`,
      [], 'all'
    );
    const bad = (rows as any[]).filter(r => r.regime === 'strong_bull' || r.regime === 'weak_bull');
    assert.equal(bad.length, 0, 'no strong_bull/weak_bull should remain in regime_history');
  });

  test('shadow_trades has new v6 columns', async () => {
    const cols = await runQuery(`PRAGMA table_info(shadow_trades)`, [], 'all');
    const names = (cols as any[]).map(c => c.name);
    for (const c of ['ratchet_stage', 'entry_slippage_frac', 'total_fee_frac', 'vpi_at_entry', 'divergence_blocked']) {
      assert.ok(names.includes(c), `column ${c} should exist`);
    }
  });
});
