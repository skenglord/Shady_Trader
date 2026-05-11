-- Create database and user (optional, can be done via environment variables)
-- CREATE DATABASE IF NOT EXISTS shady_trader;
-- CREATE USER IF NOT EXISTS shady_trader_user WITH PASSWORD 'your_password';
-- GRANT ALL PRIVILEGES ON DATABASE shady_trader TO shady_trader_user;

-- Connect to the database
\c shady_trader;

-- Create tables
CREATE TABLE IF NOT EXISTS candles (
    id SERIAL PRIMARY KEY,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    time BIGINT NOT NULL,
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
    timestamp BIGINT NOT NULL,
    risk_mode TEXT NOT NULL,
    pnl REAL,
    exit_price REAL,
    exit_timestamp BIGINT
);

CREATE TABLE IF NOT EXISTS shadow_trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    amount REAL NOT NULL,
    price REAL NOT NULL,
    status TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    risk_mode TEXT NOT NULL,
    pnl REAL,
    exit_price REAL,
    exit_timestamp BIGINT,
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
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
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
    last_updated BIGINT
);

CREATE TABLE IF NOT EXISTS market_news (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    source TEXT,
    timestamp BIGINT,
    sentiment TEXT,
    sentiment_score REAL
);

CREATE INDEX IF NOT EXISTS idx_market_news_timestamp
ON market_news(timestamp);

-- Insert default balance
INSERT INTO balances (id, main_balance, bot_balance, active_trade_balance, total_pnl, total_pnl_pct)
VALUES ('default', 100000, 0, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;