// backend/migrations/0001_regime_v2_and_ml_schema.ts

import { runQuery } from '../database.js';

export async function up(): Promise<void> {

  // Regime v2 — three-axis composite tracking
  await runQuery(`
    CREATE TABLE IF NOT EXISTS regimes_v2 (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol         TEXT    NOT NULL,
      timestamp      DATETIME DEFAULT CURRENT_TIMESTAMP,
      trend_dir      TEXT    NOT NULL,
      trend_strength TEXT    NOT NULL,
      vol_regime     TEXT    NOT NULL,
      composite      TEXT    NOT NULL,
      stability      REAL    DEFAULT 1.0,
      atr_percentile REAL,
      atr_usable     INTEGER DEFAULT 0
    )
  `, [], 'run');
  await runQuery(
    `CREATE INDEX IF NOT EXISTS idx_regimes_v2_sym_ts ON regimes_v2(symbol, timestamp)`,
    [], 'run'
  );

  // Extend shadow_trades with ratchet, slippage, and ML columns
  const cols = [
    'ratchet_state_json    TEXT',
    'ratchet_stage         INTEGER DEFAULT 0',
    'ratchet_stop          REAL',
    'highest_extreme       REAL',
    'partial_exit_fired    INTEGER DEFAULT 0',
    'entry_slippage_frac   REAL DEFAULT 0',
    'exit_slippage_frac    REAL DEFAULT 0',
    'total_fee_frac        REAL DEFAULT 0',
    'skip_reason           TEXT',
    'vpi_at_entry          REAL',
    'ml_pred_score         REAL',
    'ml_filtered           INTEGER DEFAULT 0',
    'divergence_blocked    INTEGER DEFAULT 0',
  ];

  for (const col of cols) {
    try {
      await runQuery(`ALTER TABLE shadow_trades ADD COLUMN ${col}`, [], 'run');
    } catch { /* Column already exists — idempotent */ }
  }

  // ML model registry
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ml_models (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol          TEXT NOT NULL,
      regime          TEXT NOT NULL,
      model_type      TEXT NOT NULL,
      onnx_path       TEXT NOT NULL,
      feature_count   INTEGER,
      accuracy        REAL,
      training_rows   INTEGER,
      feature_hash    TEXT,
      trained_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active       INTEGER DEFAULT 1
    )
  `, [], 'run');

  // ML prediction audit log
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ml_predictions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id       TEXT,
      symbol         TEXT,
      regime         TEXT,
      model_type     TEXT,
      pred_score     REAL,
      actual_outcome INTEGER,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, [], 'run');

  // VPI history
  await runQuery(`
    CREATE TABLE IF NOT EXISTS vpi_history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol    TEXT     NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      vpi       REAL     NOT NULL,
      label     TEXT,
      mfi       REAL,
      vol_ratio REAL,
      cvd_used  INTEGER  DEFAULT 0
    )
  `, [], 'run');
}

export async function down(): Promise<void> {
  await runQuery(`DROP TABLE IF EXISTS regimes_v2`, [], 'run');
  await runQuery(`DROP TABLE IF EXISTS ml_models`, [], 'run');
  await runQuery(`DROP TABLE IF EXISTS ml_predictions`, [], 'run');
  await runQuery(`DROP TABLE IF EXISTS vpi_history`, [], 'run');
}
