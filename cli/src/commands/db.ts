// cli/src/commands/db.ts
import { Command } from 'commander';
import chalk from 'chalk';
import { query } from '../db/sqlite.js';

export const dbCmd = new Command('db').description('Database queries (read-only)');

dbCmd.command('stats').description('Row counts for key tables').action(() => {
  const tables = ['shadow_trades', 'candles', 'regime_history', 'regimes_v2', 'signals'];
  for (const t of tables) {
    try {
      const r = query(`SELECT COUNT(*) as c FROM ${t}`);
      console.log(`${chalk.cyan(t)}: ${r[0].c}`);
    } catch {
      console.log(`${chalk.gray(t)}: (absent)`);
    }
  }
});

dbCmd.command('query <sql>').description('Run a read-only SELECT').action((sql: string) => {
  if (!/^\s*select/i.test(sql)) {
    console.error(chalk.red('Only SELECT queries are allowed'));
    process.exitCode = 1;
    return;
  }
  try { console.table(query(sql)); }
  catch (e: any) { console.error(chalk.red(e.message)); process.exitCode = 1; }
});
