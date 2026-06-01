// cli/src/commands/backtest.ts
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';

// Thin wrapper that invokes the backend backtest script (Wave 5, Block 10).
export const backtestCmd = new Command('backtest').description('Run a historical backtest');

backtestCmd
  .option('--symbol <sym>', 'symbol', 'BTCUSDT')
  .option('--mode <mode>', 'risk mode', 'conservative')
  .option('--start <date>', 'start date')
  .option('--end <date>', 'end date')
  .option('--output <file>', 'output JSON path')
  .allowUnknownOption(true)
  .action((opts: Record<string, string>) => {
    const args = ['scripts/backtest.ts'];
    for (const [k, v] of Object.entries(opts)) { args.push(`--${k}`, v); }
    console.log(chalk.cyan(`Running backtest: tsx backend/${args.join(' ')}`));
    const child = spawn('npx', ['tsx', `backend/${args[0]}`, ...args.slice(1)], { stdio: 'inherit' });
    child.on('exit', (code) => { process.exitCode = code ?? 0; });
  });
