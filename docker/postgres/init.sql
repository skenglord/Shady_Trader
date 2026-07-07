-- ============================================================================
-- Schema DDL lives in backend/database_postgres.ts (initPostgresDatabase)
-- and backend/migrations/ (applied via runMigrations at application startup).
-- This file is container-bootstrap only: it connects to the database and
-- seeds the default balance row. All table/index creation is performed by
-- the application at startup.
-- ============================================================================

-- Connect to the database
\c shady_trader;

-- Insert default balance (idempotent; safe on restart)
INSERT INTO balances (id, main_balance, bot_balance, active_trade_balance, total_pnl, total_pnl_pct)
VALUES ('default', 100000, 0, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;