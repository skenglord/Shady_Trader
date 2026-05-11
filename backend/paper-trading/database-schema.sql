-- Paper Trading Tables for PostgreSQL
-- These tables should be added to the existing database schema

-- Paper trading positions table
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

-- Paper trading orders table
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

-- Paper trading summary table (cached for performance)
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

-- Insert initial summary row
INSERT OR IGNORE INTO paper_trading_summary (id) VALUES ('summary');

-- Paper trading audit log
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

-- Trigger to update paper_positions.updated_at
CREATE TRIGGER IF NOT EXISTS update_paper_positions_timestamp 
AFTER UPDATE ON paper_positions
FOR EACH ROW
BEGIN
  UPDATE paper_positions SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
END;

-- Trigger to update paper_orders.updated_at
CREATE TRIGGER IF NOT EXISTS update_paper_orders_timestamp 
AFTER UPDATE ON paper_orders
FOR EACH ROW
BEGIN
  UPDATE paper_orders SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
END;
