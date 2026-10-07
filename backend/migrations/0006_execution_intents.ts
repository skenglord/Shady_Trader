import { runQuery } from '../database.js';

/** Durable per-candle execution claims shared by every engine replica. */
export async function up(): Promise<void> {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS execution_intents (
      idempotency_key TEXT PRIMARY KEY,
      trade_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      risk_mode TEXT NOT NULL,
      side TEXT NOT NULL,
      candle_time BIGINT NOT NULL,
      status TEXT NOT NULL,
      exchange_order_id TEXT,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `, [], 'run');
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_execution_intents_status ON execution_intents(status)`, [], 'run');
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_execution_intents_trade_id ON execution_intents(trade_id)`, [], 'run');
}

export async function down(): Promise<void> {
  await runQuery(`DROP TABLE IF EXISTS execution_intents`, [], 'run');
}
