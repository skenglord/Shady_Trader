import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDatabase, runQuery, withDatabaseTransaction } from '../../backend/database.js';
import { withPostgresTransaction } from '../../backend/database_postgres.js';

const tempDir = mkdtempSync(path.join(tmpdir(), 'shady-db-transaction-'));
process.env.DB_PATH = path.join(tempDir, 'transaction-test.sqlite');

const sqliteProbe = `transaction_probe_${randomUUID().replaceAll('-', '')}`;
const sqliteEvents: string[] = [];

before(async () => {
  await initDatabase();
  await runQuery(`CREATE TABLE ${sqliteProbe} (value TEXT NOT NULL)`);
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('database transactions', () => {
  test('commits scoped SQLite work on success', async () => {
    await withDatabaseTransaction(async query => {
      await query(`INSERT INTO ${sqliteProbe} (value) VALUES (?)`, ['committed']);
    });

    const rows = await runQuery(`SELECT value FROM ${sqliteProbe}`, [], 'all');
    assert.deepEqual(rows, [{ value: 'committed' }]);
  });

  test('rolls back scoped SQLite work on failure', async () => {
    await assert.rejects(withDatabaseTransaction(async query => {
      await query(`INSERT INTO ${sqliteProbe} (value) VALUES (?)`, ['rolled-back']);
      throw new Error('callback failed');
    }), /callback failed/);

    const rows = await runQuery(`SELECT value FROM ${sqliteProbe}`, [], 'all');
    assert.deepEqual(rows, [{ value: 'committed' }]);
  });

  test('serializes unrelated SQLite queries during an async transaction', async () => {
    let entered!: () => void;
    let release!: () => void;
    const transactionEntered = new Promise<void>(resolve => { entered = resolve; });
    const holdTransaction = new Promise<void>(resolve => { release = resolve; });

    const transaction = withDatabaseTransaction(async query => {
      sqliteEvents.push('transaction-start');
      entered();
      await holdTransaction;
      await query(`INSERT INTO ${sqliteProbe} (value) VALUES (?)`, ['transaction']);
      sqliteEvents.push('transaction-end');
    });
    await transactionEntered;

    let unrelatedQueryFinished = false;
    const unrelatedQuery = runQuery(`INSERT INTO ${sqliteProbe} (value) VALUES (?)`, ['unrelated'])
      .then(() => { unrelatedQueryFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(unrelatedQueryFinished, false);

    release();
    await Promise.all([transaction, unrelatedQuery]);
    assert.deepEqual(sqliteEvents, ['transaction-start', 'transaction-end']);
    const rows = await runQuery(`SELECT value FROM ${sqliteProbe} ORDER BY rowid`, [], 'all');
    assert.deepEqual(rows.map((row: { value: string }) => row.value), ['committed', 'transaction', 'unrelated']);
  });

  test('preserves the original SQLite error when rollback fails', async () => {
    const originalError = new Error('original callback failure');
    await assert.rejects(withDatabaseTransaction(async query => {
      await query('ROLLBACK');
      throw originalError;
    }), error => error === originalError);
  });

  test('uses one PostgreSQL client for all scoped queries', async () => {
    const calls: string[] = [];
    let releases = 0;
    const client = {
      async query(sql: string) { calls.push(sql); return { rows: [], rowCount: 1 }; },
      release() { releases++; },
    };
    const fakePool = { async connect() { return client; } };

    await withPostgresTransaction(async query => {
      await query('SELECT ?', [1], 'all');
      await query('UPDATE balances SET bot_balance = bot_balance + ?', [1]);
    }, fakePool as any);

    assert.deepEqual(calls, ['SET statement_timeout = 30000', 'BEGIN', 'SELECT $1', 'UPDATE balances SET bot_balance = bot_balance + $1', 'COMMIT']);
    assert.equal(releases, 1);
  });

  test('rolls back and releases PostgreSQL client when work fails', async () => {
    const calls: string[] = [];
    let releases = 0;
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [], rowCount: 1 };
      },
      release() { releases++; },
    };
    const fakePool = { async connect() { return client; } };
    const originalError = new Error('callback failed');

    await assert.rejects(withPostgresTransaction(async query => {
      await query('UPDATE balances SET bot_balance = bot_balance + ?', [1]);
      throw originalError;
    }, fakePool as any), error => error === originalError);

    assert.deepEqual(calls, ['SET statement_timeout = 30000', 'BEGIN', 'UPDATE balances SET bot_balance = bot_balance + $1', 'ROLLBACK']);
    assert.equal(releases, 1);
  });
});
