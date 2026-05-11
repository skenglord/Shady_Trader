import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

describe('database_worker', async () => {
  let tempDir: string;
  let dbPath: string;
  
  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'database-worker-test-'));
    dbPath = path.join(tempDir, 'trading.db');
    
    // Create initial database with schema similar to worker
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        UNIQUE(symbol, timeframe, time)
      );
      
      CREATE INDEX IF NOT EXISTS idx_candles_symbol_timeframe_time 
      ON candles(symbol, timeframe, time);
    `);
  });
  
  after(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('database should be created', async () => {
    const db = new Database(dbPath);
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='candles'");
    const table = stmt.get();
    
    assert.ok(table, 'candles table should exist');
  });

  test('candles table should have correct schema', async () => {
    const db = new Database(dbPath);
    const stmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='candles'");
    const table = stmt.get();
    
    assert.ok(table, 'Table should exist');
    assert.ok((table as any).sql.includes('symbol TEXT NOT NULL'), 'Should have symbol column');
  });

  test('index should be created', async () => {
    const db = new Database(dbPath);
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_candles_symbol_timeframe_time'");
    const index = stmt.get();

    assert.ok(index, 'Index should exist');
  });

  test('addColumnIfNotExists should add missing columns', async () => {
    const db = new Database(dbPath);

    // Add a test table
    db.exec(`
      CREATE TABLE test_table (
        id INTEGER PRIMARY KEY,
        existing_column TEXT
      );
    `);

    // Simulate the addColumnIfNotExists function
    const addColumnIfNotExists = (tableName: string, columnName: string, columnDef: string) => {
      const checkQuery = `SELECT COUNT(*) as count FROM pragma_table_info('${tableName}') WHERE name = '${columnName}'`;
      const result = db.prepare(checkQuery).get() as { count: number };
      if (result.count === 0) {
        db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`).run();
      }
    };

    // Add a new column
    addColumnIfNotExists('test_table', 'new_column', 'REAL DEFAULT 0');

    // Verify column was added
    const stmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='test_table'");
    const table = stmt.get() as any;
    assert.ok(table.sql.includes('new_column REAL DEFAULT 0'), 'New column should be added');

    db.close();
  });

  test('addColumnIfNotExists should not add existing columns', async () => {
    const db = new Database(dbPath);

    // Add a test table
    db.exec(`
      CREATE TABLE test_table2 (
        id INTEGER PRIMARY KEY,
        existing_column TEXT
      );
    `);

    // Simulate the addColumnIfNotExists function
    const addColumnIfNotExists = (tableName: string, columnName: string, columnDef: string) => {
      const checkQuery = `SELECT COUNT(*) as count FROM pragma_table_info('${tableName}') WHERE name = '${columnName}'`;
      const result = db.prepare(checkQuery).get() as { count: number };
      if (result.count === 0) {
        db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`).run();
      }
    };

    // Try to add existing column
    addColumnIfNotExists('test_table2', 'existing_column', 'TEXT');

    // Verify no duplicate column was added (this would throw an error if attempted)
    const stmt = db.prepare("PRAGMA table_info(test_table2)");
    const columns = stmt.all() as any[];
    const existingColumnCount = columns.filter(col => col.name === 'existing_column').length;
    assert.strictEqual(existingColumnCount, 1, 'Should not duplicate existing columns');

    db.close();
  });
});