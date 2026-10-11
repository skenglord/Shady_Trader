import { getTableColumnNames, runQuery } from '../database.js';

const ADDITIONAL_COLUMNS: Record<string, string[]> = {
  execution_intents: [
    'exchange_name TEXT',
    'account_id TEXT',
    'client_order_id TEXT',
    "intent_type TEXT NOT NULL DEFAULT 'entry'",
    'parent_trade_id TEXT',
    'requested_quantity NUMERIC(30, 12)',
    'filled_quantity NUMERIC(30, 12) NOT NULL DEFAULT 0',
    'average_fill_price NUMERIC(30, 12)',
    'last_observed_at BIGINT'
  ],
  shadow_trades: [
    'exchange_name TEXT',
    'account_id TEXT',
    'remaining_amount NUMERIC(30, 12)',
    'realized_pnl NUMERIC(30, 12) NOT NULL DEFAULT 0'
  ]
};

export async function up(): Promise<void> {
  for (const [table, definitions] of Object.entries(ADDITIONAL_COLUMNS)) {
    const existingColumns = await getTableColumnNames(table);
    for (const definition of definitions) {
      const columnName = definition.split(' ')[0];
      if (!existingColumns.includes(columnName)) {
        await runQuery(`ALTER TABLE ${table} ADD COLUMN ${definition}`, [], 'run');
      }
    }
  }

  await runQuery(`
    CREATE TABLE IF NOT EXISTS exchange_fills (
      exchange_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      exchange_order_id TEXT NOT NULL,
      exchange_fill_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity NUMERIC(30, 12) NOT NULL,
      price NUMERIC(30, 12) NOT NULL,
      fee NUMERIC(30, 12) NOT NULL DEFAULT 0,
      fee_currency TEXT,
      timestamp BIGINT NOT NULL,
      PRIMARY KEY (exchange_name, account_id, exchange_order_id, exchange_fill_id)
    )
  `, [], 'run');
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_exchange_fills_trade ON exchange_fills(exchange_name, account_id, trade_id, timestamp)`, [], 'run');

  await runQuery(`
    CREATE TABLE IF NOT EXISTS exchange_reconciliation_state (
      exchange_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'blocked',
      fill_cursor TEXT,
      last_checked_at BIGINT,
      last_successful_at BIGINT,
      last_error TEXT,
      PRIMARY KEY (exchange_name, account_id)
    )
  `, [], 'run');

  await runQuery(`
    CREATE TABLE IF NOT EXISTS exchange_reconciliation_incidents (
      id TEXT PRIMARY KEY,
      exchange_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      incident_type TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      resolved_at BIGINT,
      resolved_by TEXT,
      resolution_reason TEXT
    )
  `, [], 'run');
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_exchange_incidents_account_status ON exchange_reconciliation_incidents(exchange_name, account_id, status)`, [], 'run');
}

export async function down(): Promise<void> {
  await runQuery(`DROP TABLE IF EXISTS exchange_reconciliation_incidents`, [], 'run');
  await runQuery(`DROP TABLE IF EXISTS exchange_reconciliation_state`, [], 'run');
  await runQuery(`DROP TABLE IF EXISTS exchange_fills`, [], 'run');
  // Keep forward-added columns: removing them would destroy account reconciliation history.
}
