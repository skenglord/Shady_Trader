// cli/src/index.ts — Strategy Testing & Optimization CLI entry point.
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

// Ensure .env is loaded relative to the project root, not CWD.
// The server loads .env from its own location; the CLI runs from various CWDs
// (project root, cli/, /tmp, …) so we explicitly resolve and load it.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
loadDotenv({ path: path.join(projectRoot, '.env') });

import { Command } from 'commander';
import { configCmd } from './commands/config.js';
import { engineCmd } from './commands/engine.js';
import { dbCmd } from './commands/db.js';
import { logsCmd } from './commands/logs.js';
import { monitorCmd } from './commands/monitor.js';
import { backtestCmd } from './commands/backtest.js';
import { freqtradeCmd } from './commands/freqtrade.js';

const program = new Command();
program.name('trading-cli').description('Shady Bot Strategy Testing & Optimization CLI').version('1.0.0');

program.addCommand(configCmd);
program.addCommand(engineCmd);
program.addCommand(dbCmd);
program.addCommand(logsCmd);
program.addCommand(monitorCmd);
program.addCommand(backtestCmd);
program.addCommand(freqtradeCmd);

program.parse(process.argv);
