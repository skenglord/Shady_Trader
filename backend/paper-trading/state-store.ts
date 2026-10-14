import { runQuery } from '../database.js';

export interface PaperTradingStateStore {
  load(): Promise<string | null>;
  save(snapshot: string): Promise<void>;
}

/** One atomic account snapshot keeps orders, fills and idempotency in agreement. */
export class DatabasePaperTradingStateStore implements PaperTradingStateStore {
  async load(): Promise<string | null> {
    const rows = await runQuery('SELECT value FROM settings WHERE key = ?', ['paper_account_v1'], 'all');
    return rows[0]?.value ?? null;
  }
  async save(snapshot: string): Promise<void> {
    await runQuery('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['paper_account_v1', snapshot]);
  }
}
