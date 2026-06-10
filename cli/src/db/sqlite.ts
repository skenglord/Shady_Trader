// cli/src/db/sqlite.ts — direct read-only DB access for historical queries.
import Database from 'better-sqlite3';
import path from 'path';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH
      ? path.resolve(process.env.DB_PATH)
      : path.join(process.cwd(), 'trading.db');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }
  return db;
}

export function query(sql: string, params: any[] = []): any[] {
  return getDb().prepare(sql).all(...params);
}
