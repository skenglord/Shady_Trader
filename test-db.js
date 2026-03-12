import Database from 'better-sqlite3';

try {
  const db = new Database('trading.db');
  const result = db.prepare('SELECT count(*) as count FROM balances').get();
  console.log('Success:', result);
} catch (e) {
  console.error('Error:', e);
}
