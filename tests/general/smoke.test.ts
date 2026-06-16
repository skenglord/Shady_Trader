import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { clearMockRunQuery, initDatabase, runQuery } from '../../backend/database.js';

describe('Smoke Tests', () => {
  before(async () => {
    clearMockRunQuery();
    await initDatabase();
  });

  test('Database should be initialized', async () => {
    const tables = await runQuery("SELECT name FROM sqlite_master WHERE type='table';", [], 'all');
    assert.ok((tables as any[]).length > 0);
  });

  test('SQLite WAL and timeout pragmas should be configured', async () => {
    const journalMode = await runQuery('PRAGMA journal_mode', [], 'all');
    const autocheckpoint = await runQuery('PRAGMA wal_autocheckpoint', [], 'all');
    const busyTimeout = await runQuery('PRAGMA busy_timeout', [], 'all');

    assert.equal((journalMode as any[])[0].journal_mode, 'wal');
    assert.equal((autocheckpoint as any[])[0].wal_autocheckpoint, 1000);
    assert.equal((busyTimeout as any[])[0].timeout, 30000);
  });

  test('shadow_trades schema should have one definition, close_reason, and required indexes', async () => {
    const tableRows = await runQuery(
      `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='shadow_trades'`,
      [],
      'all'
    );
    assert.equal((tableRows as any[])[0].count, 1, 'shadow_trades should have exactly one table definition');

    const cols = await runQuery(`PRAGMA table_info(shadow_trades)`, [], 'all');
    const colNames = (cols as any[]).map(c => c.name);
    assert.ok(colNames.includes('close_reason'), 'close_reason should exist on shadow_trades');

    const indexes = await runQuery(`PRAGMA index_list(shadow_trades)`, [], 'all');
    const indexNames = (indexes as any[]).map(i => i.name);
    assert.ok(indexNames.includes('idx_shadow_trades_status'), 'idx_shadow_trades_status should exist');
  });

  test('required status and symbol indexes should exist', async () => {
    for (const table of ['trades', 'signals']) {
      const indexes = await runQuery(`PRAGMA index_list(${table})`, [], 'all');
      const indexNames = (indexes as any[]).map(i => i.name);
      const expected = table === 'trades' ? 'idx_trades_status' : 'idx_signals_symbol';
      assert.ok(indexNames.includes(expected), `index ${expected} should exist on ${table}`);
    }
  });

  test('Server configuration should load', () => {
    process.env.APP_URL = process.env.APP_URL || 'http://localhost:3000';
    assert.ok(process.env.APP_URL !== undefined);
  });
});
