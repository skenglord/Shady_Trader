import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initDatabase, runQuery, withDatabaseTransaction } from '../../backend/database.js';
import { closePostgresPool } from '../../backend/database_postgres.js';

const postgresEnabled = process.env.USE_POSTGRES === 'true';
const table = `postgres_smoke_${randomUUID().replaceAll('-', '')}`;

test('PostgreSQL initializes, binds parameters, and commits or rolls back transactions', {
  skip: !postgresEnabled,
}, async () => {
  await initDatabase();
  await runQuery(`CREATE TABLE ${table} (value TEXT NOT NULL)`);

  try {
    await withDatabaseTransaction(async query => {
      await query(`INSERT INTO ${table} (value) VALUES (?)`, ['committed']);
    });

    assert.deepEqual(await runQuery(`SELECT value FROM ${table}`, [], 'all'), [{ value: 'committed' }]);

    await assert.rejects(withDatabaseTransaction(async query => {
      await query(`INSERT INTO ${table} (value) VALUES (?)`, ['rolled back']);
      throw new Error('force rollback');
    }), /force rollback/);

    assert.deepEqual(await runQuery(`SELECT value FROM ${table}`, [], 'all'), [{ value: 'committed' }]);
  } finally {
    await runQuery(`DROP TABLE IF EXISTS ${table}`);
  }
});

after(async () => {
  if (postgresEnabled) await closePostgresPool();
});
