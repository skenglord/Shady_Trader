/**
 * Migration 0005 — shadow_trades close_reason and query indexes
 *
 * Adds the close_reason column to existing SQLite databases and creates the
 * missing status/symbol indexes used by common trade and signal lookups.
 */
import { runQuery } from '../database.js';

const INDEXES = [
  { name: 'idx_shadow_trades_status', table: 'shadow_trades', columns: 'status' },
  { name: 'idx_signals_symbol', table: 'signals', columns: 'symbol' },
  { name: 'idx_trades_status', table: 'trades', columns: 'status' },
] as const;

export async function up(): Promise<void> {
  const columns = await runQuery('PRAGMA table_info(shadow_trades)', [], 'all') as Array<{ name: string }>;
  const hasCloseReason = columns.some(column => column.name === 'close_reason');

  if (!hasCloseReason) {
    await runQuery('ALTER TABLE shadow_trades ADD COLUMN close_reason TEXT DEFAULT NULL', [], 'run');
  }

  for (const index of INDEXES) {
    await runQuery(
      `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table}(${index.columns})`,
      [],
      'run'
    );
  }
}

export async function down(): Promise<void> {
  for (const index of INDEXES) {
    await runQuery(`DROP INDEX IF EXISTS ${index.name}`, [], 'run');
  }

  const columns = await runQuery('PRAGMA table_info(shadow_trades)', [], 'all') as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'close_reason')) {
    return;
  }

  try {
    await runQuery('ALTER TABLE shadow_trades DROP COLUMN close_reason', [], 'run');
  } catch (err: any) {
    const message = err?.message ?? String(err);
    // SQLite versions without DROP COLUMN support cannot remove close_reason; leave it nullable.
    if (/not support|syntax error|near "DROP"|no such column: close_reason/i.test(message)) {
      return;
    }
    throw err;
  }
}
