import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scriptPath = join('/home/creekz/Shady_Trader', 'backend/freqtrade/scripts/bulk_ingest_candles.py');
const venvPython = '/home/creekz/Shady_Trader/backend/freqtrade/venv/bin/python3';

/**
 * Helper: query the SQLite DB via Python and return a scalar result.
 */
function dbQueryScalar(dbPath: string, sql: string): number {
  const pyScript = `
import sqlite3
conn = sqlite3.connect("${dbPath.replace(/"/g, '\\"')}")
cur = conn.execute("""${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}""")
result = cur.fetchone()
print(result[0] if result else 0)
conn.close()
`;
  const result = execSync(`"${venvPython}" -c "${pyScript.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
  });
  return parseInt(result.trim(), 10);
}

function createTablesScript(dbPath: string): string {
  return `
import sqlite3
conn = sqlite3.connect("${dbPath.replace(/"/g, '\\"')}")
conn.executescript("""
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
""")
conn.commit()
conn.close()
`;
}

describe('bulk_ingest_candles.py', () => {
  let tmpDir: string;
  let dbPath: string;
  let dataDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'freqtrade-ingest-test-'));
    dbPath = join(tmpDir, 'test.db');
    dataDir = join(tmpDir, 'data', 'binance');
    mkdirSync(dataDir, { recursive: true });

    // Create DB with table using Python
    execSync(`"${venvPython}" -c "${createTablesScript(dbPath).replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      shell: '/bin/sh',
    });

    // Create synthetic feather + parquet files with Python
    const createDataPy = join(tmpDir, 'create_test_data.py');
    writeFileSync(createDataPy, `
import pandas as pd
import os

data_dir = "${dataDir.replace(/"/g, '\\"')}"

# BTC/USDT 1h - 10 candles
df1 = pd.DataFrame({
    'date': [1609459200000 + i * 3600000 for i in range(10)],
    'open': [40000.0 + i * 100 for i in range(10)],
    'high': [40200.0 + i * 100 for i in range(10)],
    'low': [39800.0 + i * 100 for i in range(10)],
    'close': [40100.0 + i * 100 for i in range(10)],
    'volume': [10.0 + i * 1 for i in range(10)],
})
df1.to_feather(os.path.join(data_dir, 'BTC_USDT-1h.feather'))

# ETH/USDT 5m - 5 candles
df2 = pd.DataFrame({
    'date': [1609459200000 + i * 300000 for i in range(5)],
    'open': [2000.0 + i * 10 for i in range(5)],
    'high': [2020.0 + i * 10 for i in range(5)],
    'low': [1980.0 + i * 10 for i in range(5)],
    'close': [2010.0 + i * 10 for i in range(5)],
    'volume': [100.0 + i * 5 for i in range(5)],
})
df2.to_feather(os.path.join(data_dir, 'ETH_USDT-5m.feather'))

# SOL/USDT 1d (parquet) - 3 candles
df3 = pd.DataFrame({
    'date': [1609459200000 + i * 86400000 for i in range(3)],
    'open': [100.0 + i * 5 for i in range(3)],
    'high': [105.0 + i * 5 for i in range(3)],
    'low': [95.0 + i * 5 for i in range(3)],
    'close': [102.0 + i * 5 for i in range(3)],
    'volume': [5000.0 + i * 100 for i in range(3)],
})
df3.to_parquet(os.path.join(data_dir, 'SOL_USDT-1d.parquet'))
`);
    execSync(`"${venvPython}" "${createDataPy}"`, { encoding: 'utf-8', cwd: tmpDir });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ingests feather and parquet files correctly', () => {
    const output = execSync(
      `"${venvPython}" "${scriptPath}" --db "${dbPath}" --data-dir "${join(tmpDir, 'data')}"`,
      { encoding: 'utf-8' }
    );

    // Check progress output
    assert(output.includes('BTC/USDT/1h:'), `Expected BTC/USDT/1h: ${output}`);
    assert(output.includes('ETH/USDT/5m:'), `Expected ETH/USDT/5m: ${output}`);
    assert(output.includes('SOL/USDT/1d:'), `Expected SOL/USDT/1d: ${output}`);
    assert(output.includes('Total:'), `Expected Total: ${output}`);
    assert(output.includes('Bulk ingest complete.'), `Expected completion: ${output}`);

    // Verify total row count
    const totalRows = dbQueryScalar(dbPath, 'SELECT COUNT(*) FROM candles;');
    assert.strictEqual(totalRows, 18, `Expected 18 total rows, got ${totalRows}`);

    // Per-symbol counts
    const btcCount = dbQueryScalar(dbPath, "SELECT COUNT(*) FROM candles WHERE symbol='BTC/USDT';");
    assert.strictEqual(btcCount, 10, `Expected 10 BTC rows, got ${btcCount}`);

    const ethCount = dbQueryScalar(dbPath, "SELECT COUNT(*) FROM candles WHERE symbol='ETH/USDT';");
    assert.strictEqual(ethCount, 5, `Expected 5 ETH rows, got ${ethCount}`);

    const solCount = dbQueryScalar(dbPath, "SELECT COUNT(*) FROM candles WHERE symbol='SOL/USDT';");
    assert.strictEqual(solCount, 3, `Expected 3 SOL rows, got ${solCount}`);
  });

  test('is idempotent on re-run', () => {
    // Run twice more
    execSync(`"${venvPython}" "${scriptPath}" --db "${dbPath}" --data-dir "${join(tmpDir, 'data')}"`, {
      encoding: 'utf-8',
    });
    execSync(`"${venvPython}" "${scriptPath}" --db "${dbPath}" --data-dir "${join(tmpDir, 'data')}"`, {
      encoding: 'utf-8',
    });

    const totalRows = dbQueryScalar(dbPath, 'SELECT COUNT(*) FROM candles;');
    assert.strictEqual(totalRows, 18, `Expected 18 rows after idempotent re-run, got ${totalRows}`);
  });

  test('dry-run mode does not insert', () => {
    const tmpDir2 = join(tmpdir(), 'freqtrade-dryrun-test-' + Date.now());
    const dbPath2 = join(tmpDir2, 'test.db');
    const dataDir2 = join(tmpDir2, 'data', 'binance');
    mkdirSync(dataDir2, { recursive: true });

    // Create DB + one file
    execSync(`"${venvPython}" -c "${createTablesScript(dbPath2).replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
    });

    const dfPy = join(tmpDir2, 'df.py');
    writeFileSync(dfPy, `
import pandas as pd
df = pd.DataFrame({
    'date': [1609459200000],
    'open': [100.0],
    'high': [110.0],
    'low': [90.0],
    'close': [105.0],
    'volume': [1000.0],
})
df.to_feather("${dataDir2.replace(/"/g, '\\"')}/TEST_USDT-1h.feather")
`);
    execSync(`"${venvPython}" "${dfPy}"`, { encoding: 'utf-8' });

    // Dry run
    const output = execSync(
      `"${venvPython}" "${scriptPath}" --db "${dbPath2}" --data-dir "${join(tmpDir2, 'data')}" --dry-run`,
      { encoding: 'utf-8' }
    );
    assert(output.includes('[DRY RUN]'), `Expected dry run message: ${output}`);

    const countAfter = dbQueryScalar(dbPath2, 'SELECT COUNT(*) FROM candles;');
    assert.strictEqual(countAfter, 0, `Expected 0 rows after dry run, got ${countAfter}`);

    rmSync(tmpDir2, { recursive: true, force: true });
  });
});
