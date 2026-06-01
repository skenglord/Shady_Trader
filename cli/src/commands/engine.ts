// cli/src/commands/engine.ts
import { Command } from 'commander';
import chalk from 'chalk';
import { apiGet, apiPost } from '../utils/api.js';

export const engineCmd = new Command('engine').description('Control the trading engine');

engineCmd.command('status').description('Show engine status').action(async () => {
  try {
    const s = await apiGet('/status');
    console.log(chalk.green('Engine status:'));
    console.log(JSON.stringify(s, null, 2));
  } catch (e: any) {
    console.error(chalk.red(`Cannot reach bot: ${e.message}`));
    process.exitCode = 1;
  }
});

engineCmd.command('start').description('Start the engine').action(async () => {
  try { console.log(await apiPost('/start')); }
  catch (e: any) { console.error(chalk.red(e.message)); process.exitCode = 1; }
});

engineCmd.command('stop').description('Stop the engine').action(async () => {
  try { console.log(await apiPost('/stop')); }
  catch (e: any) { console.error(chalk.red(e.message)); process.exitCode = 1; }
});

engineCmd.command('restart').description('Restart the engine').action(async () => {
  try { await apiPost('/stop'); await apiPost('/start'); console.log(chalk.green('restarted')); }
  catch (e: any) { console.error(chalk.red(e.message)); process.exitCode = 1; }
});
