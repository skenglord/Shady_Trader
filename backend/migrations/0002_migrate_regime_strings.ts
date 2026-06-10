// backend/migrations/0002_migrate_regime_strings.ts
//
// * Bug Fix 7: The DB contains regime strings in underscore format
// ('strong_bull', 'weak_bull') from the original implementation.
// The canonical format (Block 2.1) uses no underscores ('strongbull', 'weakbull').
// This migration normalises all historical records so ML training
// and analytics queries use consistent values.

import { runQuery } from '../database.js';

const RENAMES: [string, string][] = [
  ['strong_bull', 'strongbull'],
  ['weak_bull',   'weakbull'],
  // 'bear', 'sideways', 'uncertain' need no renaming — already canonical
];

const TABLES = [
  { table: 'regime_history',      col: 'regime' },
  { table: 'shadow_trades',       col: 'regime' },
  { table: 'daily_performance',   col: 'regime' },
  { table: 'optimization_trials', col: 'regime' },
];

export async function up(): Promise<void> {
  console.log('[migration 0002] Normalising regime strings...');
  for (const { table, col } of TABLES) {
    for (const [oldVal, newVal] of RENAMES) {
      try {
        await runQuery(
          `UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`,
          [newVal, oldVal], 'run'
        );
      } catch { /* Table/column may not exist in all env — skip gracefully */ }
    }
  }
  console.log('[migration 0002] Done');
}

export async function down(): Promise<void> {
  for (const { table, col } of TABLES) {
    for (const [oldVal, newVal] of RENAMES) {
      try {
        await runQuery(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [oldVal, newVal], 'run');
      } catch { /* ignore */ }
    }
  }
}
