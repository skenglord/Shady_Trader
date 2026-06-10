/**
 * Migration 0003 — freqtrade_jobs table
 *
 * Persists the state of every Freqtrade sidecar job (download, backtest, validate)
 * so the API can list/inspect/cancel them. Phase 3 of the Freqtrade integration plan.
 *
 *   documentation/upgrades/freqtrade_integration_plan.md §6 Phase 3 step 3.6
 */
import { runQuery } from '../database.js';

export const migrationId = '0003_freqtrade_jobs';
export const description = 'freqtrade_jobs table for the Freqtrade sidecar integration';

export async function up(): Promise<void> {
    await runQuery(`
    CREATE TABLE IF NOT EXISTS freqtrade_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('download','backtest','validate')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
      exchange TEXT,
      strategy TEXT,
      timerange_start TEXT,
      timerange_end TEXT,
      params_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error TEXT,
      pid INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `, [], 'run');

    await runQuery(`CREATE INDEX IF NOT EXISTS idx_freqtrade_jobs_status   ON freqtrade_jobs(status)`, [], 'run');
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_freqtrade_jobs_type     ON freqtrade_jobs(type)`, [], 'run');
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_freqtrade_jobs_created  ON freqtrade_jobs(created_at DESC)`, [], 'run');
}

export async function down(): Promise<void> {
    await runQuery(`DROP TABLE IF EXISTS freqtrade_jobs`, [], 'run');
}
