import path from 'path';
import { initPostgresDatabase, runPostgresQuery } from './database_postgres.js';

let mockRunQuery: ((sql: string, params: any[], type: 'run' | 'all') => Promise<any>) | null = null;
const QUERY_TIMEOUT_MS = 30000; // 30 second timeout per query
const USE_POSTGRES = process.env.USE_POSTGRES === 'true';

export async function initDatabase() {
  if (USE_POSTGRES) {
    console.log('Using PostgreSQL database');
    await initPostgresDatabase();
  } else {
    console.log('Using SQLite database');
    // Setup mockRunQuery to use SQLite directly in main thread to avoid worker thread issues
    try {
      const Database = await import('better-sqlite3');
      const dbPath = path.join(process.cwd(), 'trading.db');
      const db = new Database.default(dbPath);
      // Apply pragmas for better performance and concurrency
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = -64000');
      db.pragma('busy_timeout = 5000');
      
      mockRunQuery = async (sql: string, params: any[] = [], type: 'run' | 'all' = 'run'): Promise<any> => {
        try {
          if (type === 'all') {
            const stmt = db.prepare(sql);
            return stmt.all(...params);
          } else {
            const stmt = db.prepare(sql);
            return stmt.run(...params);
          }
        } catch (error) {
          // Re-throw to be handled by caller
          throw error;
        }
      };
    } catch (error) {
      console.error('Failed to initialize SQLite database:', error);
      throw error;
    }
  }
}

export function setMockRunQuery(fn: typeof mockRunQuery) {
  mockRunQuery = fn;
}

export async function runQuery(sql: string, params: any[] = [], type: 'run' | 'all' = 'run'): Promise<any> {
  if (mockRunQuery) return mockRunQuery(sql, params, type);

  if (USE_POSTGRES) {
    return runPostgresQuery(sql, params, type);
  }

  // This should not happen if initDatabase was called, but provide fallback
  throw new Error('Database not initialized');
}