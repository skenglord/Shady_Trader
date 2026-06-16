import { Pool } from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const QUERY_TIMEOUT_MS = 30000; // 30 second timeout per query

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'shady_trader',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '',
  max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20'), // Connection pooling
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Initialize database schema
export async function initPostgresDatabase() {
  let client;
  try {
    client = await pool.connect();
    // Enable WAL mode equivalent (PostgreSQL has WAL by default)
    await client.query('SET synchronous_commit = on');
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);

    // Create tables
    await client.query(`
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
    `);

    await client.query(`
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

      CREATE INDEX IF NOT EXISTS idx_trades_status
      ON trades(status);
    `);

    await client.query(`
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
        take_profit REAL,
        close_reason TEXT DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_shadow_trades_status
      ON shadow_trades(status);
      CREATE INDEX IF NOT EXISTS idx_shadow_trades_risk_mode_status
      ON shadow_trades(risk_mode, status);
      CREATE INDEX IF NOT EXISTS idx_shadow_trades_timestamp
      ON shadow_trades(timestamp);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_performance (
        date TEXT PRIMARY KEY,
        risk_mode TEXT NOT NULL,
        total_pnl REAL NOT NULL,
        win_rate REAL NOT NULL,
        trades_count INTEGER NOT NULL,
        UNIQUE(date, risk_mode)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS regime_history (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        regime TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        reasoning TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_regime_history_timestamp
      ON regime_history(timestamp);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS balances (
        id TEXT PRIMARY KEY,
        main_balance REAL NOT NULL DEFAULT 100000,
        bot_balance REAL NOT NULL DEFAULT 0,
        active_trade_balance REAL NOT NULL DEFAULT 0,
        total_pnl REAL NOT NULL DEFAULT 0,
        total_pnl_pct REAL NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS market_data (
        id TEXT PRIMARY KEY,
        market_cap REAL,
        total_volume REAL,
        fear_greed_index INTEGER,
        fear_greed_value TEXT,
        btc_dominance REAL,
        last_updated BIGINT
      );
    `);

    await client.query(`
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
    `);

    // Slippage modeling tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_book_snapshots (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        bids JSONB NOT NULL,
        asks JSONB NOT NULL,
        spread REAL NOT NULL,
        mid_price REAL NOT NULL,
        total_bid_depth REAL NOT NULL,
        total_ask_depth REAL NOT NULL,
        update_id BIGINT NOT NULL,
        exchange TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_order_book_snapshots_symbol_timestamp
      ON order_book_snapshots(symbol, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_order_book_snapshots_timestamp
      ON order_book_snapshots(timestamp);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS slippage_history (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
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
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_slippage_history_symbol_timestamp
      ON slippage_history(symbol, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_slippage_history_regime
      ON slippage_history(regime);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS toxicity_metrics (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
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
    `);

    // Audit tables for regulatory compliance
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_trades (
        id TEXT PRIMARY KEY,
        trade_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        risk_mode TEXT,
        leverage REAL,
        symbol TEXT,
        side TEXT,
        amount REAL,
        price REAL,
        exit_reason TEXT,
        pnl REAL,
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_audit_trades_trade_id
      ON audit_trades(trade_id);
      CREATE INDEX IF NOT EXISTS idx_audit_trades_timestamp
      ON audit_trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_trades_event_type
      ON audit_trades(event_type);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_balances (
        id TEXT PRIMARY KEY,
        balance_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        before_main_balance REAL,
        before_bot_balance REAL,
        before_active_balance REAL,
        after_main_balance REAL,
        after_bot_balance REAL,
        after_active_balance REAL,
        change_amount REAL,
        reason TEXT,
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_audit_balances_balance_id
      ON audit_balances(balance_id);
      CREATE INDEX IF NOT EXISTS idx_audit_balances_timestamp
      ON audit_balances(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_balances_event_type
      ON audit_balances(event_type);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_user_actions (
        id TEXT PRIMARY KEY,
        user_role TEXT,
        ip_address INET,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        request_body JSONB,
        response_status INTEGER,
        timestamp BIGINT NOT NULL,
        error_message TEXT,
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_audit_user_actions_timestamp
      ON audit_user_actions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_user_actions_endpoint
      ON audit_user_actions(endpoint);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_system_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        severity TEXT DEFAULT 'info',
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_audit_system_events_timestamp
      ON audit_system_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_system_events_event_type
      ON audit_system_events(event_type);
    `);

    // Archive tables for long-term audit storage
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_trades_archive (
        id TEXT PRIMARY KEY,
        trade_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        risk_mode TEXT,
        leverage REAL,
        symbol TEXT,
        side TEXT,
        amount REAL,
        price REAL,
        exit_reason TEXT,
        pnl REAL,
        metadata JSONB,
        archived_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000
      );

      CREATE INDEX IF NOT EXISTS idx_audit_trades_archive_timestamp
      ON audit_trades_archive(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_trades_archive_archived_at
      ON audit_trades_archive(archived_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_balances_archive (
        id TEXT PRIMARY KEY,
        balance_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        before_main_balance REAL,
        before_bot_balance REAL,
        before_active_balance REAL,
        after_main_balance REAL,
        after_bot_balance REAL,
        after_active_balance REAL,
        change_amount REAL,
        reason TEXT,
        metadata JSONB,
        archived_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000
      );

      CREATE INDEX IF NOT EXISTS idx_audit_balances_archive_timestamp
      ON audit_balances_archive(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_balances_archive_archived_at
      ON audit_balances_archive(archived_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_user_actions_archive (
        id TEXT PRIMARY KEY,
        user_role TEXT,
        ip_address INET,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        request_body JSONB,
        response_status INTEGER,
        timestamp BIGINT NOT NULL,
        error_message TEXT,
        metadata JSONB,
        archived_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000
      );

      CREATE INDEX IF NOT EXISTS idx_audit_user_actions_archive_timestamp
      ON audit_user_actions_archive(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_user_actions_archive_archived_at
      ON audit_user_actions_archive(archived_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_system_events_archive (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        severity TEXT DEFAULT 'info',
        metadata JSONB,
        archived_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000
      );
    `);

    // Optimization trials table for Bayesian optimization
    await client.query(`
      CREATE TABLE IF NOT EXISTS optimization_trials (
        id SERIAL PRIMARY KEY,
        regime TEXT NOT NULL,
        mode TEXT NOT NULL,
        params JSONB NOT NULL,
        score REAL NOT NULL,
        timestamp BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_optimization_trials_regime_mode
      ON optimization_trials(regime, mode);
      CREATE INDEX IF NOT EXISTS idx_optimization_trials_timestamp
      ON optimization_trials(timestamp);
    `);

    // Order reconciliation log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_reconciliation_log (
        id SERIAL PRIMARY KEY,
        exchange_name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        local_quantity REAL NOT NULL,
        exchange_quantity REAL NOT NULL,
        discrepancy REAL NOT NULL,
        resolved BOOLEAN NOT NULL DEFAULT FALSE,
        resolution_action TEXT,
        timestamp BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_order_reconciliation_log_exchange_symbol
      ON order_reconciliation_log(exchange_name, symbol);
      CREATE INDEX IF NOT EXISTS idx_order_reconciliation_log_timestamp
      ON order_reconciliation_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_order_reconciliation_log_resolved
      ON order_reconciliation_log(resolved);
    `);

    // Paper trading tables
    await client.query(`
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
        created_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000,
        updated_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000
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
        created_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000,
        updated_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000,
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
        updated_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000
      );

      INSERT INTO paper_trading_summary (id) VALUES ('summary')
      ON CONFLICT (id) DO NOTHING;

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
        metadata JSONB,
        created_at BIGINT NOT NULL DEFAULT EXTRACT(epoch from NOW()) * 1000
      );

      CREATE INDEX IF NOT EXISTS idx_paper_audit_timestamp
      ON paper_trading_audit(timestamp);

      CREATE INDEX IF NOT EXISTS idx_paper_audit_event_type
      ON paper_trading_audit(event_type);
    `);

    // Insert default balance if not exists
    await client.query(`
      INSERT INTO balances (id, main_balance, bot_balance, active_trade_balance, total_pnl, total_pnl_pct)
      VALUES ('default', 100000, 0, 0, 0, 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log('PostgreSQL database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize PostgreSQL database:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Query execution function compatible with existing runQuery interface
export async function runPostgresQuery(sql: string, params: any[] = [], type: 'run' | 'all' = 'run'): Promise<any> {
  let client;
  try {
    client = await pool.connect();
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);
    if (type === 'all') {
      const result = await client.query(sql, params);
      return result.rows;
    } else {
      const result = await client.query(sql, params);
      return {
        changes: result.rowCount || 0,
        lastInsertRowid: result.rows?.[0]?.id || undefined
      };
    }
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Migration function to copy data from SQLite to PostgreSQL
export async function migrateFromSQLite(sqliteDbPath: string) {
  const Database = (await import('better-sqlite3')).default;
  const sqliteDb = Database(sqliteDbPath);

  console.log('Starting migration from SQLite to PostgreSQL...');

  const tables = ['candles', 'trades', 'shadow_trades', 'daily_performance', 'regime_history', 'settings', 'balances', 'market_data', 'market_news'];

  for (const table of tables) {
    console.log(`Migrating table: ${table}`);

    const rows = sqliteDb.prepare(`SELECT * FROM ${table}`).all();

    if (rows.length === 0) {
      console.log(`No data in ${table}, skipping...`);
      continue;
    }

    const columns = Object.keys(rows[0]).join(', ');
    const placeholders = Object.keys(rows[0]).map(() => '?').join(', ');

    const insertSql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    for (const row of rows) {
      const values = Object.values(row);
      await runPostgresQuery(insertSql, values, 'run');
    }

    console.log(`Migrated ${rows.length} rows from ${table}`);
  }

  sqliteDb.close();
  console.log('Migration completed successfully');
}

// Graceful shutdown
export async function closePostgresPool() {
  await pool.end();
}