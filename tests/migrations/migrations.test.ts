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

  test('freqtrade_hyperopt_results table exists (v6.1 Task 1)', async () => {
    const rows = await runQuery(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='freqtrade_hyperopt_results'`,
      [], 'all'
    );
    assert.equal((rows as any[]).length, 1, 'freqtrade_hyperopt_results table should exist');
  });

  test('freqtrade_hyperopt_results has all 13 required columns', async () => {
    const cols = await runQuery(`PRAGMA table_info(freqtrade_hyperopt_results)`, [], 'all');
    const names = (cols as any[]).map(c => c.name);
    const required = [
      'id', 'job_id', 'mode', 'strategy', 'timerange_start', 'timerange_end',
      'pairs', 'timeframe', 'epochs', 'best_loss', 'best_params',
      'all_results', 'created_at', 'applied_at',
    ];
    for (const c of required) {
      assert.ok(names.includes(c), `column ${c} should exist`);
    }
  });

  test('freqtrade_hyperopt_results has job_id UNIQUE constraint', async () => {
    const idx = await runQuery(`PRAGMA index_list(freqtrade_hyperopt_results)`, [], 'all');
    const names = (idx as any[]).map(i => i.name);
    // UNIQUE constraint creates an implicit index named sqlite_autoindex_*_1
    const hasUnique = names.some(n => n.startsWith('sqlite_autoindex_freqtrade_hyperopt_results'));
    assert.ok(hasUnique, `expected UNIQUE(job_id) implicit index; got: ${names.join(', ')}`);
  });

  test('freqtrade_hyperopt_results has the two named indexes', async () => {
    const idx = await runQuery(`PRAGMA index_list(freqtrade_hyperopt_results)`, [], 'all');
    const names = (idx as any[]).map(i => i.name);
    assert.ok(names.includes('idx_freqtrade_hyperopt_mode_created'),
      `expected idx_freqtrade_hyperopt_mode_created; got: ${names.join(', ')}`);
    assert.ok(names.includes('idx_freqtrade_hyperopt_applied'),
      `expected idx_freqtrade_hyperopt_applied; got: ${names.join(', ')}`);
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
