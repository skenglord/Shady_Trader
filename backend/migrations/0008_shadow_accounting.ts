import { getTableColumnNames, runQuery } from '../database.js';

export async function up(): Promise<void> {
  const columns = await getTableColumnNames('shadow_trades');
  for (const definition of [
    'wallet_owned INTEGER',
    'reserved_margin NUMERIC(30, 12) NOT NULL DEFAULT 0',
    'is_runner INTEGER NOT NULL DEFAULT 0',
    'candles_held INTEGER NOT NULL DEFAULT 0',
    'last_update_time BIGINT',
  ]) {
    if (!columns.includes(definition.split(' ')[0])) {
      await runQuery(`ALTER TABLE shadow_trades ADD COLUMN ${definition}`);
    }
  }
  // Legacy ownership cannot be inferred from the mode currently selected.
  // Keep it NULL so settlement requires explicit reconciliation of those rows.
  await runQuery(`UPDATE shadow_trades SET remaining_amount = amount
    WHERE remaining_amount IS NULL AND status = 'open'`);
  await runQuery(`CREATE TABLE IF NOT EXISTS shadow_settlements (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    risk_mode TEXT NOT NULL,
    quantity NUMERIC(30, 12) NOT NULL,
    pnl NUMERIC(30, 12) NOT NULL,
    timestamp BIGINT NOT NULL
  )`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_shadow_settlements_trade ON shadow_settlements(trade_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_shadow_settlements_mode_time ON shadow_settlements(risk_mode, timestamp)`);
}
