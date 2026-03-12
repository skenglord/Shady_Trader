import { parentPort } from 'worker_threads';
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'trading.db');
const db = new Database(dbPath);

// Initialize tables
db.pragma('journal_mode = DELETE');
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

  INSERT OR IGNORE INTO balances (id, main_balance, bot_balance, active_trade_balance, total_pnl, total_pnl_pct)
  VALUES ('default', 100000, 0, 0, 0, 0);
`);

try { db.prepare('ALTER TABLE shadow_trades ADD COLUMN stop_loss REAL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE shadow_trades ADD COLUMN take_profit REAL').run(); } catch(e) {}

parentPort?.on('message', (message) => {
  const { id, sql, params, type } = message;
  try {
    if (type === 'all') {
      const stmt = db.prepare(sql);
      const result = stmt.all(...params);
      parentPort?.postMessage({ id, result });
    } else {
      const stmt = db.prepare(sql);
      const result = stmt.run(...params);
      parentPort?.postMessage({ id, result });
    }
  } catch (error) {
    parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
