-- ============================================================================
-- Schema DDL lives in backend/database_postgres.ts (initPostgresDatabase)
-- and backend/migrations/ (applied via runMigrations at application startup).
-- This file is container-bootstrap only: it connects to the database.
-- All table/index creation AND the default balance seed are performed by the
-- application at startup (initPostgresDatabase seeds 'default' idempotently
-- via INSERT ... ON CONFLICT (id) DO NOTHING). Do NOT seed here: this file
-- runs at container init (ON_ERROR_STOP=1) BEFORE any table exists, so an
-- INSERT INTO balances here would abort a fresh-volume boot.
-- ============================================================================

-- Connect to the database
\c shady_trader;