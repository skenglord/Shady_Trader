import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toPostgresSql } from '../../backend/database_postgres.js';

describe('PostgreSQL SQL compatibility layer', () => {
  test('converts bind markers without changing question marks in literals', () => {
    assert.equal(
      toPostgresSql("SELECT * FROM trades WHERE symbol = ? AND note = '?' AND status = ?"),
      "SELECT * FROM trades WHERE symbol = $1 AND note = '?' AND status = $2"
    );
  });

  test('translates SQLite ignore and replace inserts to conflict clauses', () => {
    assert.equal(
      toPostgresSql('INSERT OR IGNORE INTO candles (symbol, time) VALUES (?, ?)'),
      'INSERT INTO candles (symbol, time) VALUES ($1, $2) ON CONFLICT DO NOTHING'
    );
    assert.equal(
      toPostgresSql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
    );
  });

  test('translates SQLite migration DDL defaults', () => {
    assert.equal(
      toPostgresSql("CREATE TABLE x (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER DEFAULT (strftime('%s','now') * 1000))"),
      'CREATE TABLE x (id BIGSERIAL PRIMARY KEY, created_at INTEGER DEFAULT (((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)))'
    );
  });
});
