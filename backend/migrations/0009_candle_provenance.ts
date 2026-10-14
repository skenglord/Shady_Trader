import { runQuery } from '../database.js';

export async function up(): Promise<void> {
  await runQuery(`CREATE TABLE IF NOT EXISTS candle_provenance (
    symbol TEXT NOT NULL, timeframe TEXT NOT NULL, time BIGINT NOT NULL,
    provider TEXT NOT NULL, fetched_at BIGINT NOT NULL, finalized INTEGER NOT NULL,
    volume_available INTEGER NOT NULL,
    PRIMARY KEY (symbol, timeframe, time)
  )`);
}

export async function down(): Promise<void> {
  await runQuery('DROP TABLE IF EXISTS candle_provenance');
}
