import path from 'path';
import { initPostgresDatabase, runPostgresQuery } from './database_postgres.js';

let mockRunQuery: ((sql: string, params: any[], type: 'run' | 'all') => Promise<any>) | null = null;
const QUERY_TIMEOUT_MS = 30000; // 30 second timeout per query
const USE_POSTGRES = process.env.USE_POSTGRES === 'true';

export async function initDatabase() {
  if (USE_POSTGRES) {
    console.log('Using PostgreSQL database');
    await initPostgresDatabase();
  } else {
    console.log('Using SQLite database');
    // Setup mockRunQuery to use SQLite directly in main thread to avoid worker thread issues
    try {
      const Database = await import('better-sqlite3');
      const dbPath = path.join(process.cwd(), 'trading.db');
      const db = new Database.default(dbPath);
      // Apply pragmas for better performance and concurrency
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = -64000');
      db.pragma('busy_timeout = 5000');

      // Create tables if they don't exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS candles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          timeframe TEXT NOT NULL,
          time INTEGER NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume REAL NOT NULL,
          UNIQUE(symbol, timeframe, time)
        );

        CREATE TABLE IF NOT EXISTS trades (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          amount REAL NOT NULL,
          price REAL NOT NULL,
          status TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          risk_mode TEXT NOT NULL,
          pnl REAL,
          exit_price REAL,
          exit_timestamp INTEGER
        );

        CREATE TABLE IF NOT EXISTS shadow_trades (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          amount REAL NOT NULL,
          price REAL NOT NULL,
          status TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          risk_mode TEXT NOT NULL,
          pnl REAL,
          exit_price REAL,
          exit_timestamp INTEGER,
          leverage REAL DEFAULT 1,
          stop_loss REAL,
          take_profit REAL
        );

        CREATE TABLE IF NOT EXISTS daily_performance (
          date TEXT PRIMARY KEY,
          risk_mode TEXT NOT NULL,
          total_pnl REAL NOT NULL,
          win_rate REAL NOT NULL,
          trades_count INTEGER NOT NULL,
          UNIQUE(date, risk_mode)
        );

        CREATE TABLE IF NOT EXISTS regime_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          regime TEXT NOT NULL,
          confidence INTEGER NOT NULL,
          reasoning TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS balances (
          id TEXT PRIMARY KEY,
          main_balance REAL NOT NULL DEFAULT 100000,
          bot_balance REAL NOT NULL DEFAULT 0,
          active_trade_balance REAL NOT NULL DEFAULT 0,
          total_pnl REAL NOT NULL DEFAULT 0,
          total_pnl_pct REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS market_data (
          id TEXT PRIMARY KEY,
          market_cap REAL,
          total_volume REAL,
          fear_greed_index INTEGER,
          fear_greed_value TEXT,
          btc_dominance REAL,
          last_updated INTEGER
        );

        CREATE TABLE IF NOT EXISTS market_news (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          source TEXT,
          timestamp INTEGER,
          sentiment TEXT,
          sentiment_score REAL
        );

        CREATE TABLE IF NOT EXISTS order_book_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          bids TEXT NOT NULL,
          asks TEXT NOT NULL,
          spread REAL NOT NULL,
          mid_price REAL NOT NULL,
          total_bid_depth REAL NOT NULL,
          total_ask_depth REAL NOT NULL,
          update_id INTEGER NOT NULL,
          exchange TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS slippage_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          side TEXT NOT NULL,
          order_size REAL NOT NULL,
          order_type TEXT NOT NULL,
          predicted_slippage REAL NOT NULL,
          realized_slippage REAL,
          confidence REAL NOT NULL,
          regime TEXT NOT NULL,
          volatility REAL NOT NULL,
          market_impact REAL NOT NULL,
          spread_cost REAL NOT NULL,
          temporary_impact REAL NOT NULL,
          exchange TEXT NOT NULL,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS toxicity_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          vpin REAL NOT NULL,
          order_imbalance REAL NOT NULL,
          large_trade_ratio REAL NOT NULL,
          spread_volatility REAL NOT NULL,
          depth_volatility REAL NOT NULL,
          exchange TEXT NOT NULL
        );
      `);

      mockRunQuery = async (sql: string, params: any[] = [], type: 'run' | 'all' = 'run'): Promise<any> => {
        try {
          if (type === 'all') {
            const stmt = db.prepare(sql);
            return stmt.all(...params);
          } else {
            const stmt = db.prepare(sql);
            return stmt.run(...params);
          }
        } catch (error) {
          // Re-throw to be handled by caller
          throw error;
        }
      };
    } catch (error) {
      console.error('Failed to initialize SQLite database:', error);
      throw error;
    }
  }
}

export function setMockRunQuery(fn: typeof mockRunQuery) {
  mockRunQuery = fn;
}

export async function runQuery(sql: string, params: any[] = [], type: 'run' | 'all' = 'run'): Promise<any> {
  if (mockRunQuery) return mockRunQuery(sql, params, type);

  if (USE_POSTGRES) {
    return runPostgresQuery(sql, params, type);
  }

  // This should not happen if initDatabase was called, but provide fallback
  throw new Error('Database not initialized');
}