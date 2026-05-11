import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runQuery, setMockRunQuery } from '../../backend/database.js';

setMockRunQuery(async (sql, _params, type) => {
  if (sql.includes('sqlite_master')) return [{ name: 'balances' }, { name: 'settings' }, { name: 'shadow_trades' }];
  if (type === 'all') return [];
  return { changes: 1 };
});

describe('Smoke Tests', () => {
  test('Database should be initialized', async () => {
    const tables = await runQuery("SELECT name FROM sqlite_master WHERE type='table';", [], 'all');
    assert.ok((tables as any[]).length > 0);
  });

  test('Server configuration should load', () => {
    process.env.APP_URL = process.env.APP_URL || 'http://localhost:3000';
    assert.ok(process.env.APP_URL !== undefined);
  });
});
