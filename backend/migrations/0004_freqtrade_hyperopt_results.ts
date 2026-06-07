/**
 * Migration 0004 — freqtrade_hyperopt_results table
 *
 * Persists the output of every `freqtrade hyperopt` run (one row per job_id)
 * so the API/CLI can list history, inspect trials, and apply the best
 * parameters back to the in-house risk config. Phase 1 of the v6.1
 * Freqtrade hyperopt integration plan.
 *
 *   .hermes/plans/2026-06-07_082426-freqtrade-hyperopt-v6.1.md — Task 1
 *
 * Columns:
 *   - id              autoincrement PK
 *   - job_id          caller-provided BullMQ job id (also written to freqtrade_jobs.id)
 *   - mode            risk mode (conservative / moderate / aggressive / …) — matches RISK_MODES
 *   - strategy        Freqtrade strategy class name (e.g. "ShadyTraderReferenceStrategy")
 *   - timerange_start / timerange_end  YYYYMMDD strings passed to freqtrade
 *   - pairs           JSON array of pairs as a TEXT column
 *   - timeframe       candle timeframe (e.g. "1h")
 *   - epochs          number of hyperopt trials
 *   - best_loss       objective value of the best trial (loss-function dependent)
 *   - best_params     JSON object — the tuned parameters from the best trial
 *   - all_results     JSON array — top 20 trials (sorted by best_loss)
 *   - created_at      unix epoch ms when the row was written
 *   - applied_at      unix epoch ms when the in-house config adopted these params
 *                     (NULL = not yet applied)
 *
 * Indexes:
 *   - (mode, created_at DESC) for "latest result per mode" lookups
 *   - (mode, applied_at DESC) WHERE applied_at IS NOT NULL for "last applied
 *     result per mode" lookups (partial index — sparse)
 */
import { runQuery } from '../database.js';

export const migrationId = '0004_freqtrade_hyperopt_results';
export const description = 'freqtrade_hyperopt_results table for the v6.1 hyperopt integration';

export async function up(): Promise<void> {
    await runQuery(`
        CREATE TABLE IF NOT EXISTS freqtrade_hyperopt_results (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id          TEXT    NOT NULL,
            mode            TEXT    NOT NULL,
            strategy        TEXT    NOT NULL,
            timerange_start TEXT    NOT NULL,
            timerange_end   TEXT    NOT NULL,
            pairs           TEXT    NOT NULL,
            timeframe       TEXT    NOT NULL,
            epochs          INTEGER NOT NULL,
            best_loss       REAL    NOT NULL,
            best_params     TEXT    NOT NULL,
            all_results     TEXT    NOT NULL,
            created_at      INTEGER NOT NULL,
            applied_at      INTEGER,
            UNIQUE(job_id)
        )
    `, [], 'run');

    await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_freqtrade_hyperopt_mode_created
            ON freqtrade_hyperopt_results(mode, created_at DESC)
    `, [], 'run');

    await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_freqtrade_hyperopt_applied
            ON freqtrade_hyperopt_results(mode, applied_at DESC)
            WHERE applied_at IS NOT NULL
    `, [], 'run');
}

export async function down(): Promise<void> {
    await runQuery(`DROP INDEX IF EXISTS idx_freqtrade_hyperopt_applied`, [], 'run');
    await runQuery(`DROP INDEX IF EXISTS idx_freqtrade_hyperopt_mode_created`, [], 'run');
    await runQuery(`DROP TABLE IF EXISTS freqtrade_hyperopt_results`, [], 'run');
}
