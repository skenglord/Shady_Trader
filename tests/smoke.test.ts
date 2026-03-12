import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runQuery } from '../backend/database.js';

describe('Smoke Tests', () => {
  test('Database should be initialized', async () => {
    const tables = await runQuery("SELECT name FROM sqlite_master WHERE type='table';", [], 'all');
    assert.ok((tables as any[]).length > 0);
  });

  test('Server configuration should load', () => {
    assert.ok(process.env.APP_URL !== undefined);
  });
});
