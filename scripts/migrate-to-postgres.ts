#!/usr/bin/env tsx

import { initPostgresDatabase, migrateFromSQLite, closePostgresPool } from '../backend/database_postgres.js';
import path from 'path';

async function main() {
  try {
    console.log('Initializing PostgreSQL database...');
    await initPostgresDatabase();

    const sqlitePath = path.join(process.cwd(), 'trading.db');
    console.log(`Migrating data from SQLite database at: ${sqlitePath}`);

    await migrateFromSQLite(sqlitePath);

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closePostgresPool();
  }
}

main();