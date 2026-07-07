// backend/migrations/runner.ts

import { up as m0001 } from './0001_regime_v2_and_ml_schema.js';
import { up as m0002 } from './0002_migrate_regime_strings.js';
import { up as m0003 } from './0003_freqtrade_jobs.js';
import { up as m0004 } from './0004_freqtrade_hyperopt_results.js';
import { up as m0005 } from './0005_shadow_trades_close_reason_and_indexes.js';
import { logger }       from '../logging/logger.js';
import { runQuery }     from '../database.js';

/**
 * Ensure the schema_migrations state table exists before any migration runs.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe on every boot.
 *
 * Columns:
 *   id          TEXT PRIMARY KEY  — migration identifier, e.g. "0001"
 *   applied_at  TEXT NOT NULL     — ISO-8601 timestamp generated in JS
 *
 * TEXT columns are chosen for maximum cross-DB portability (SQLite + Postgres)
 * and to avoid driver-specific timestamp quirks.
 */
async function ensureMigrationsTable(): Promise<void> {
  await runQuery(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    )`,
    [],
    'run'
  );
}

/**
 * Return the list of migration ids that have been recorded as applied,
 * sorted ascending for deterministic ordering.
 */
export async function listAppliedMigrations(): Promise<string[]> {
  const rows = await runQuery(
    `SELECT id FROM schema_migrations ORDER BY id ASC`,
    [],
    'all'
  );
  return (rows || []).map((r: any) => r.id);
}

export async function runMigrations(): Promise<void> {
  const migrations = [
    { id: '0001', name: 'regime_v2_and_ml_schema',     run: m0001 },
    { id: '0002', name: 'migrate_regime_strings',      run: m0002 },
    { id: '0003', name: 'freqtrade_jobs',              run: m0003 },
    { id: '0004', name: 'freqtrade_hyperopt_results',  run: m0004 },
    { id: '0005', name: 'shadow_trades_close_reason_and_indexes', run: m0005 },
  ];

  logger.info('Starting migration runner', { service: 'migrations' });

  // Ensure the state table exists before any migration logic runs.
  await ensureMigrationsTable();

  for (const m of migrations) {
    // Check whether this migration has already been applied.
    const existing = await runQuery(
      `SELECT id FROM schema_migrations WHERE id = ?`,
      [m.id],
      'all'
    );

    if (existing && existing.length > 0) {
      logger.info(`Skipping ${m.id}: already applied`, { service: 'migrations' });
      continue;
    }

    // Execute the migration. If it throws, let the error propagate
    // (fail-fast) — do NOT record it as applied and do NOT continue.
    logger.info(`Running ${m.id}: ${m.name}`, { service: 'migrations' });
    await m.run();

    // Record successful execution immediately.
    await runQuery(
      `INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      [m.id, new Date().toISOString()],
      'run'
    );
  }

  logger.info('All migrations complete', { service: 'migrations' });
}
