import Database from 'better-sqlite3';
import { setMockRunQuery, setMockRunTransaction } from '../../backend/database.js';

export function createShadowTestStore() {
  const recorded: { sql: string; params: any[]; type: string }[] = [];
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE shadow_trades (
      id TEXT PRIMARY KEY, symbol TEXT, side TEXT, amount REAL, remaining_amount REAL,
      price REAL, status TEXT, timestamp INTEGER, risk_mode TEXT, leverage REAL,
      stop_loss REAL, take_profit REAL, pnl REAL, realized_pnl REAL DEFAULT 0,
      exit_price REAL, exit_timestamp INTEGER, close_reason TEXT,
      exchange_name TEXT, account_id TEXT, entry_slippage_frac REAL, total_fee_frac REAL,
      wallet_owned INTEGER, reserved_margin REAL DEFAULT 0, is_runner INTEGER DEFAULT 0,
      candles_held INTEGER DEFAULT 0, last_update_time INTEGER
    );
    CREATE TABLE execution_intents (
      idempotency_key TEXT PRIMARY KEY, trade_id TEXT, symbol TEXT, risk_mode TEXT,
      side TEXT, candle_time INTEGER, status TEXT, created_at INTEGER, updated_at INTEGER,
      exchange_name TEXT, account_id TEXT, client_order_id TEXT, intent_type TEXT,
      requested_quantity REAL, exchange_order_id TEXT
    );
    CREATE TABLE balances (id TEXT PRIMARY KEY, main_balance REAL, bot_balance REAL,
      active_trade_balance REAL, total_pnl REAL, total_pnl_pct REAL);
    INSERT INTO balances VALUES ('default', 0, 1000, 0, 0, 0);
    CREATE TABLE audit_balances (id TEXT, balance_id TEXT, event_type TEXT, timestamp INTEGER,
      before_main_balance REAL, before_bot_balance REAL, before_active_balance REAL,
      after_main_balance REAL, after_bot_balance REAL, after_active_balance REAL,
      change_amount REAL, reason TEXT, metadata TEXT);
    CREATE TABLE audit_trades (id TEXT PRIMARY KEY, trade_id TEXT, event_type TEXT,
      timestamp INTEGER, risk_mode TEXT, leverage REAL, symbol TEXT, side TEXT,
      amount REAL, price REAL, exit_reason TEXT, pnl REAL, metadata TEXT);
    CREATE TABLE audit_system_events (id TEXT, event_type TEXT, message TEXT,
      timestamp INTEGER, severity TEXT, metadata TEXT);
    CREATE TABLE shadow_settlements (id TEXT PRIMARY KEY, trade_id TEXT, risk_mode TEXT,
      quantity REAL, pnl REAL, timestamp INTEGER);
  `);
  const query = async (sql: string, params: any[] = [], type: 'run' | 'all' = 'run') => {
    recorded.push({ sql, params, type });
    return type === 'all' ? db.prepare(sql).all(...params) : db.prepare(sql).run(...params);
  };
  setMockRunQuery(query);
  let queue = Promise.resolve();
  setMockRunTransaction(async work => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    db.exec('BEGIN');
    try {
      const result = await work(query);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally { release(); }
  });
  return { db, query, recorded };
}

export function persistShadowTestTrade(db: Database.Database, trade: any) {
  db.prepare(`INSERT INTO shadow_trades
    (id, symbol, side, amount, remaining_amount, price, status, timestamp, risk_mode,
     leverage, stop_loss, take_profit, total_fee_frac, wallet_owned, reserved_margin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    trade.id, trade.symbol, trade.side, trade.amount, trade.amount, trade.price,
    trade.status || 'open', trade.timestamp || Date.now(), trade.risk_mode || 'moderate',
    trade.leverage || 1, trade.stopLoss ?? null, trade.takeProfit ?? null, trade.totalFeeFrac ?? 0,
    trade.wallet_owned ?? 0, trade.reserved_margin ?? 0);
}
