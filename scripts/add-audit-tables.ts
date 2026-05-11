#!/usr/bin/env tsx

import { runQuery } from '../backend/database.js';
import { closePostgresPool } from '../backend/database_postgres.js';

async function addAuditTables() {
  console.log('Adding audit tables to database...');

  try {
    // Audit trades table
    await runQuery(`
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
        metadata ${process.env.USE_POSTGRES === 'true' ? 'JSONB' : 'TEXT'}
      )
    `);

    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_trades_trade_id ON audit_trades(trade_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_trades_timestamp ON audit_trades(timestamp)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_trades_event_type ON audit_trades(event_type)`);

    // Audit balances table
    await runQuery(`
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
        metadata ${process.env.USE_POSTGRES === 'true' ? 'JSONB' : 'TEXT'}
      )
    `);

    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_balances_balance_id ON audit_balances(balance_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_balances_timestamp ON audit_balances(timestamp)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_balances_event_type ON audit_balances(event_type)`);

    // Audit user actions table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS audit_user_actions (
        id TEXT PRIMARY KEY,
        user_role TEXT,
        ip_address ${process.env.USE_POSTGRES === 'true' ? 'INET' : 'TEXT'},
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        request_body ${process.env.USE_POSTGRES === 'true' ? 'JSONB' : 'TEXT'},
        response_status INTEGER,
        timestamp BIGINT NOT NULL,
        error_message TEXT,
        metadata ${process.env.USE_POSTGRES === 'true' ? 'JSONB' : 'TEXT'}
      )
    `);

    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_user_actions_timestamp ON audit_user_actions(timestamp)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_user_actions_endpoint ON audit_user_actions(endpoint)`);

    // Audit system events table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS audit_system_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        severity TEXT DEFAULT 'info',
        metadata ${process.env.USE_POSTGRES === 'true' ? 'JSONB' : 'TEXT'}
      )
    `);

    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_system_events_timestamp ON audit_system_events(timestamp)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_system_events_event_type ON audit_system_events(event_type)`);

    console.log('Audit tables added successfully!');
  } catch (error) {
    console.error('Failed to add audit tables:', error);
    throw error;
  } finally {
    if (process.env.USE_POSTGRES === 'true') {
      await closePostgresPool();
    }
  }
}

addAuditTables();