// cli/src/commands/freqtrade.ts — Freqtrade sidecar CLI commands.
// Each subcommand calls the running bot's REST API (no logic duplication).
import { Command } from 'commander';
import chalk from 'chalk';
import { apiGet, apiPost } from '../utils/api.js';
import { normalizeFreqtradeTimerange, normalizeValidateTolerance } from '../../../backend/freqtrade/validation.js';

export const freqtradeCmd = new Command('freqtrade').description('Freqtrade sidecar operations');

function parseTimerange(value: string) {
  if (!value.includes('-')) return undefined;
  const [start, end] = value.split('-');
  return normalizeFreqtradeTimerange({ start, end });
}

// ── freqtrade info ───────────────────────────────────────────────────
freqtradeCmd.command('info').description('Show Freqtrade sidecar status').action(async () => {
  try {
    const info = await apiGet('/freqtrade/info');
    console.log(chalk.green('Freqtrade sidecar status:'));
    console.log(JSON.stringify(info, null, 2));
  } catch (e: any) {
    console.error(chalk.red(`Cannot reach bot: ${e.message}`));
    process.exitCode = 1;
  }
});

// ── freqtrade jobs ───────────────────────────────────────────────────
freqtradeCmd
  .command('jobs')
  .description('List Freqtrade jobs')
  .option('--limit <n>', 'max number of jobs', '20')
  .action(async (opts: { limit: string }) => {
    try {
      const result = await apiGet(`/freqtrade/jobs?limit=${opts.limit}`);
      const jobs = result.jobs ?? [];
      if (jobs.length === 0) {
        console.log(chalk.yellow('No Freqtrade jobs found.'));
        return;
      }
      console.log(chalk.green(`Freqtrade jobs (${jobs.length}):`));
      for (const job of jobs) {
        const statusColor = job.status === 'completed' ? chalk.green
          : job.status === 'failed' ? chalk.red
          : job.status === 'running' ? chalk.blue
          : chalk.gray;
        console.log(`  ${chalk.bold(job.type)}  ${statusColor(job.status)}  ${chalk.gray(job.id.slice(0, 8))}...`);
      }
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });

// ── freqtrade job <id> ───────────────────────────────────────────────
freqtradeCmd
  .command('job')
  .description('Show a single Freqtrade job')
  .argument('<id>', 'job ID')
  .action(async (id: string) => {
    try {
      const result = await apiGet(`/freqtrade/jobs/${encodeURIComponent(id)}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });

// ── freqtrade cancel <id> ────────────────────────────────────────────
freqtradeCmd
  .command('cancel')
  .description('Cancel a Freqtrade job')
  .argument('<id>', 'job ID')
  .action(async (id: string) => {
    try {
      const result = await apiPost(`/freqtrade/jobs/${encodeURIComponent(id)}/cancel`);
      console.log(chalk.green(result.message || 'Job cancelled'));
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });

// ── freqtrade pairs ──────────────────────────────────────────────────
freqtradeCmd
  .command('pairs')
  .description('List available pairs / candles')
  .action(async () => {
    try {
      const result = await apiGet('/freqtrade/pairs');
      const pairs = result.pairs ?? [];
      if (pairs.length === 0) {
        console.log(chalk.yellow('No pairs found.'));
        return;
      }
      for (const p of pairs) {
        console.log(`${chalk.bold(p.pair ?? p.symbol)}  ${chalk.gray(p.timeframe)}`);
      }
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });

// ── freqtrade download ───────────────────────────────────────────────
freqtradeCmd
  .command('download')
  .description('Download historical data via Freqtrade')
  .requiredOption('--exchange <name>', 'exchange name', 'binance')
  .option('--pairs <list>', 'comma-separated pairs', 'BTC/USDT:USDT,ETH/USDT:USDT')
  .option('--timeframes <list>', 'comma-separated timeframes', '1h,4h,1d')
  .option('--trading-mode <mode>', 'spot|futures|margin', 'futures')
  .option('--data-format <format>', 'json|feather|parquet', 'parquet')
  .option('--timerange <range>', 'e.g. 20240101-20241231')
  .action(async (opts: Record<string, string>) => {
    try {
      const body: any = {
        exchange: opts.exchange,
        pairs: opts.pairs.split(',').map((s: string) => s.trim()),
        timeframes: opts.timeframes.split(',').map((s: string) => s.trim()),
        tradingMode: opts.tradingMode,
        dataFormat: opts.dataFormat,
      };
      const timerange = parseTimerange(opts.timerange || '');
      if (timerange) body.timerange = timerange;
      const result = await apiPost('/freqtrade/download-data', body);
      console.log(chalk.green(`Download queued: ${result.jobId}`));
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });

// ── freqtrade backtest ───────────────────────────────────────────────
freqtradeCmd
  .command('backtest')
  .description('Run a Freqtrade backtest')
  .requiredOption('--strategy <name>', 'strategy class name')
  .option('--timerange <range>', 'e.g. 20240101-20241231')
  .option('--pairs <list>', 'comma-separated pairs', 'BTC/USDT:USDT')
  .option('--timeframe <tf>', 'candle timeframe', '1h')
  .option('--wallet <n>', 'dry-run wallet USDT', '10000')
  .action(async (opts: Record<string, string>) => {
    try {
      const body: any = {
        strategy: opts.strategy,
        pairs: opts.pairs.split(',').map((s: string) => s.trim()),
        timeframe: opts.timeframe || '1h',
        dryRunWallet: parseFloat(opts.wallet) || 10000,
      };
      const timerange = parseTimerange(opts.timerange || '');
      if (timerange) body.timerange = timerange;
      const result = await apiPost('/freqtrade/backtest', body);
      console.log(chalk.green(`Backtest queued: ${result.jobId}`));
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });

// ── freqtrade validate ───────────────────────────────────────────────
freqtradeCmd
  .command('validate')
  .description('Run cross-validation (in-house vs Freqtrade)')
  .requiredOption('--strategy <name>', 'strategy class name')
  .requiredOption('--symbol <sym>', 'trading pair', 'BTC/USDT')
  .option('--timerange <range>', 'e.g. 20240101-20241231')
  .option('--mode <mode>', 'risk mode', 'moderate')
  .option('--pairs <list>', 'comma-separated pairs', 'BTC/USDT:USDT')
  .option('--timeframe <tf>', 'candle timeframe', '1h')
  .option('--tolerance <n>', 'metric tolerance', '0.05')
  .action(async (opts: Record<string, string>) => {
    try {
      const body: any = {
        strategy: opts.strategy,
        symbol: opts.symbol,
        mode: opts.mode,
        pairs: opts.pairs.split(',').map((s: string) => s.trim()),
        timeframe: opts.timeframe || '1h',
        dryRunWallet: 10000,
        tolerance: normalizeValidateTolerance(opts.tolerance),
      };
      const timerange = parseTimerange(opts.timerange || '');
      if (timerange) body.timerange = timerange;
      const result = await apiPost('/freqtrade/validate', body);
      console.log(chalk.green('Validation result:'));
      console.log(JSON.stringify(result, null, 2));
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });

// ── freqtrade ingest ─────────────────────────────────────────────────
freqtradeCmd
  .command('ingest')
  .description('Bulk-ingest Freqtrade data into the trading DB')
  .action(async () => {
    try {
      const result = await apiPost('/freqtrade/ingest');
      console.log(chalk.green('Ingest result:'), result.message || 'OK');
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });
