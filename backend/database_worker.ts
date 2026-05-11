import { parentPort } from 'worker_threads';
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'trading.db');
const db = new Database(dbPath);

// Initialize tables
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('busy_timeout = 5000');
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

  CREATE INDEX IF NOT EXISTS idx_candles_symbol_timeframe_time 
  ON candles(symbol, timeframe, time);
  CREATE INDEX IF NOT EXISTS idx_candles_time 
  ON candles(time);

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

  CREATE INDEX IF NOT EXISTS idx_shadow_trades_risk_mode_status 
  ON shadow_trades(risk_mode, status);
  CREATE INDEX IF NOT EXISTS idx_shadow_trades_timestamp 
  ON shadow_trades(timestamp);

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

  CREATE INDEX IF NOT EXISTS idx_regime_history_timestamp 
  ON regime_history(timestamp);

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

  CREATE INDEX IF NOT EXISTS idx_market_news_timestamp
  ON market_news(timestamp);

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

  CREATE INDEX IF NOT EXISTS idx_order_book_snapshots_symbol_timestamp
  ON order_book_snapshots(symbol, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_order_book_snapshots_timestamp
  ON order_book_snapshots(timestamp);

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

  CREATE INDEX IF NOT EXISTS idx_slippage_history_symbol_timestamp
  ON slippage_history(symbol, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_slippage_history_regime
  ON slippage_history(regime);

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

  CREATE INDEX IF NOT EXISTS idx_toxicity_metrics_symbol_timestamp
  ON toxicity_metrics(symbol, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_toxicity_metrics_timestamp
  ON toxicity_metrics(timestamp);

  CREATE TABLE IF NOT EXISTS audit_trades (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    risk_mode TEXT,
    leverage REAL,
    symbol TEXT,
    side TEXT,
    amount REAL,
    price REAL,
    exit_reason TEXT,
    pnl REAL,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_trades_trade_id
  ON audit_trades(trade_id);
  CREATE INDEX IF NOT EXISTS idx_audit_trades_timestamp
  ON audit_trades(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_trades_event_type
  ON audit_trades(event_type);

  CREATE TABLE IF NOT EXISTS audit_balances (
    id TEXT PRIMARY KEY,
    balance_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    before_main_balance REAL,
    before_bot_balance REAL,
    before_active_balance REAL,
    after_main_balance REAL,
    after_bot_balance REAL,
    after_active_balance REAL,
    change_amount REAL,
    reason TEXT,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_balances_balance_id
  ON audit_balances(balance_id);
  CREATE INDEX IF NOT EXISTS idx_audit_balances_timestamp
  ON audit_balances(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_balances_event_type
  ON audit_balances(event_type);

  CREATE TABLE IF NOT EXISTS audit_user_actions (
    id TEXT PRIMARY KEY,
    user_role TEXT,
    ip_address TEXT,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    request_body TEXT,
    response_status INTEGER,
    timestamp INTEGER NOT NULL,
    error_message TEXT,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_user_actions_timestamp
  ON audit_user_actions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_user_actions_endpoint
  ON audit_user_actions(endpoint);

  CREATE TABLE IF NOT EXISTS audit_system_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    severity TEXT DEFAULT 'info',
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_system_events_timestamp
  ON audit_system_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_system_events_event_type
  ON audit_system_events(event_type);

  CREATE TABLE IF NOT EXISTS audit_trades_archive (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    risk_mode TEXT,
    leverage REAL,
    symbol TEXT,
    side TEXT,
    amount REAL,
    price REAL,
    exit_reason TEXT,
    pnl REAL,
    metadata TEXT,
    archived_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_trades_archive_timestamp
  ON audit_trades_archive(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_trades_archive_archived_at
  ON audit_trades_archive(archived_at);

  CREATE TABLE IF NOT EXISTS audit_balances_archive (
    id TEXT PRIMARY KEY,
    balance_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    before_main_balance REAL,
    before_bot_balance REAL,
    before_active_balance REAL,
    after_main_balance REAL,
    after_bot_balance REAL,
    after_active_balance REAL,
    change_amount REAL,
    reason TEXT,
    metadata TEXT,
    archived_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_balances_archive_timestamp
  ON audit_balances_archive(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_balances_archive_archived_at
  ON audit_balances_archive(archived_at);

  CREATE TABLE IF NOT EXISTS audit_user_actions_archive (
    id TEXT PRIMARY KEY,
    user_role TEXT,
    ip_address TEXT,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    request_body TEXT,
    response_status INTEGER,
    timestamp INTEGER NOT NULL,
    error_message TEXT,
    metadata TEXT,
    archived_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_user_actions_archive_timestamp
  ON audit_user_actions_archive(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_user_actions_archive_archived_at
  ON audit_user_actions_archive(archived_at);

  CREATE TABLE IF NOT EXISTS audit_system_events_archive (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    severity TEXT DEFAULT 'info',
    metadata TEXT,
    archived_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_system_events_archive_timestamp
  ON audit_system_events_archive(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_system_events_archive_archived_at
  ON audit_system_events_archive(archived_at);

  // Paper trading tables
  CREATE TABLE IF NOT EXISTS paper_positions (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    quantity REAL NOT NULL,
    entry_price REAL NOT NULL,
    current_price REAL,
    stop_loss REAL,
    take_profit REAL,
    leverage INTEGER NOT NULL DEFAULT 1 CHECK (leverage >= 1 AND leverage <= 100),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'liquidated')),
    unrealized_pnl REAL DEFAULT 0,
    realized_pnl REAL DEFAULT 0,
    opened_at BIGINT NOT NULL,
    closed_at BIGINT,
    candles_held INTEGER DEFAULT 0,
    exit_reason TEXT,
    created_at BIGINT NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at BIGINT NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_paper_positions_symbol_status 
  ON paper_positions(symbol, status);

  CREATE INDEX IF NOT EXISTS idx_paper_positions_opened_at 
  ON paper_positions(opened_at);

  CREATE INDEX IF NOT EXISTS idx_paper_positions_status 
  ON paper_positions(status);

  CREATE TABLE IF NOT EXISTS paper_orders (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    type TEXT NOT NULL CHECK (type IN ('market', 'limit')),
    quantity REAL NOT NULL,
    price REAL,
    filled_quantity REAL DEFAULT 0,
    fill_price REAL,
    time_in_force TEXT NOT NULL CHECK (time_in_force IN ('GTC', 'IOC', 'FOK')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'expired')),
    idempotency_key TEXT,
    position_id TEXT REFERENCES paper_positions(id),
    created_at BIGINT NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at BIGINT NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    filled_at BIGINT
  );

  CREATE INDEX IF NOT EXISTS idx_paper_orders_status 
  ON paper_orders(status);

  CREATE INDEX IF NOT EXISTS idx_paper_orders_idempotency 
  ON paper_orders(idempotency_key);

  CREATE INDEX IF NOT EXISTS idx_paper_orders_created_at 
  ON paper_orders(created_at);

  CREATE TABLE IF NOT EXISTS paper_trading_summary (
    id TEXT PRIMARY KEY DEFAULT 'summary',
    total_unrealized_pnl REAL DEFAULT 0,
    total_realized_pnl REAL DEFAULT 0,
    total_margin_used REAL DEFAULT 0,
    open_positions INTEGER DEFAULT 0,
    closed_positions INTEGER DEFAULT 0,
    liquidated_positions INTEGER DEFAULT 0,
    updated_at BIGINT NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  INSERT OR IGNORE INTO paper_trading_summary (id) VALUES ('summary');

  CREATE TABLE IF NOT EXISTS paper_trading_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    position_id TEXT,
    order_id TEXT,
    symbol TEXT,
    side TEXT,
    quantity REAL,
    price REAL,
    timestamp BIGINT NOT NULL,
    metadata TEXT,
    created_at BIGINT NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_paper_audit_timestamp 
  ON paper_trading_audit(timestamp);

  CREATE INDEX IF NOT EXISTS idx_paper_audit_event_type
  ON paper_trading_audit(event_type);
`);

// Add columns with IF NOT EXISTS pattern instead of try/catch
const addColumnIfNotExists = (tableName: string, columnName: string, columnDef: string) => {
  const checkQuery = 'SELECT COUNT(*) as count FROM pragma_table_info(\'' + tableName + '\') WHERE name = \'' + columnName + '\'';
  const result = db.prepare(checkQuery).get() as { count: number };
  if (result.count === 0) {
    const alterQuery = 'ALTER TABLE ' + tableName + ' ADD COLUMN ' + columnName + ' ' + columnDef;
    db.prepare(alterQuery).run();
  }
};

addColumnIfNotExists('shadow_trades', 'stop_loss', 'REAL');
addColumnIfNotExists('shadow_trades', 'take_profit', 'REAL');
addColumnIfNotExists('shadow_trades', 'leverage', 'REAL DEFAULT 1');

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
