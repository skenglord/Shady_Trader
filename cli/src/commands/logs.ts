// cli/src/commands/logs.ts
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

export const logsCmd = new Command('logs').description('Tail bot logs');

logsCmd
  .option('-f, --follow', 'follow the log file')
  .option('-n, --lines <n>', 'lines to show', '40')
  .action((opts: { follow?: boolean; lines: string }) => {
    const logFile = process.env.LOG_DIR
      ? path.join(process.env.LOG_DIR, 'trading-system.log')
      : path.join(process.cwd(), 'logs', 'trading-system.log');

    if (!fs.existsSync(logFile)) {
      console.error(chalk.red(`Log file not found: ${logFile}`));
      process.exitCode = 1;
      return;
    }

    const all = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    all.slice(-parseInt(opts.lines, 10)).forEach(l => console.log(l));

    if (opts.follow) {
      let size = fs.statSync(logFile).size;
      fs.watchFile(logFile, { interval: 500 }, () => {
        const s = fs.statSync(logFile).size;
        if (s > size) {
          const fd = fs.openSync(logFile, 'r');
          const buf = Buffer.alloc(s - size);
          fs.readSync(fd, buf, 0, s - size, size);
          fs.closeSync(fd);
          process.stdout.write(buf.toString());
          size = s;
        }
      });
    }
  });
