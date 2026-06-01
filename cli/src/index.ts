// cli/src/index.ts — Strategy Testing & Optimization CLI entry point.
import { Command } from 'commander';
import { configCmd } from './commands/config.js';
import { engineCmd } from './commands/engine.js';
import { dbCmd } from './commands/db.js';
import { logsCmd } from './commands/logs.js';
import { monitorCmd } from './commands/monitor.js';
import { backtestCmd } from './commands/backtest.js';

const program = new Command();
program.name('trading-cli').description('Shady Bot Strategy Testing & Optimization CLI').version('1.0.0');

program.addCommand(configCmd);
program.addCommand(engineCmd);
program.addCommand(dbCmd);
program.addCommand(logsCmd);
program.addCommand(monitorCmd);
program.addCommand(backtestCmd);

program.parse(process.argv);
