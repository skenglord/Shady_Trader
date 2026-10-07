// cli/src/commands/freqtrade.ts — Freqtrade sidecar CLI commands.
// Each subcommand calls the running bot's REST API (no logic duplication).
import { Command } from 'commander';
import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, apiPost } from '../utils/api.js';
import { normalizeFreqtradeTimerange, normalizeValidateTolerance } from '../../../backend/freqtrade/validation.js';
import { FreqtradeBridge } from '../../../backend/freqtrade/bridge.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultPairs = process.env.FREQTRADE_DEFAULT_PAIRS || 'BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT';
const defaultTimeframes = process.env.FREQTRADE_DEFAULT_TIMEFRAMES || '1m,5m,15m,1h,4h,1d';

function prepareLocalFreqtradeConfig() {
  // Freqtrade interpolates API settings from config.json even for one-shot CLI
  // jobs. These ephemeral credentials only satisfy config parsing; no server
  // is started and no credential is persisted.
  process.env.FREQTRADE__API_SERVER__USERNAME ||= process.env.FREQTRADE_API_USER || `cli-${randomBytes(8).toString('hex')}`;
  process.env.FREQTRADE__API_SERVER__PASSWORD ||= process.env.FREQTRADE_API_PASS || randomBytes(32).toString('hex');
  process.env.FREQTRADE__API_SERVER__JWT_SECRET_KEY ||= process.env.FREQTRADE_JWT_SECRET_KEY || randomBytes(32).toString('hex');
}

async function runLocalDownload(request: Parameters<FreqtradeBridge['downloadData']>[0]) {
  prepareLocalFreqtradeConfig();
  const bridge = new FreqtradeBridge({ downloadTimeoutMs: 0 });
  const events = await bridge.downloadData(request);
  let failed = false;
  for await (const event of events) {
    if (event.type === 'error') failed = true;
    console.log(event.line);
  }
  if (failed) process.exitCode = 1;
}

async function runLocalBacktest(request: Parameters<FreqtradeBridge['runBacktest']>[0]) {
  prepareLocalFreqtradeConfig();
  const result = await new FreqtradeBridge({ backtestTimeoutMs: 0 }).runBacktest(request);
  console.log(JSON.stringify(result, null, 2));
  if (!result.metadata.success) process.exitCode = 1;
}

function runLocalIngest() {
  const python = path.join(projectRoot, 'backend/freqtrade/venv/bin/python');
  const script = path.join(projectRoot, 'backend/freqtrade/scripts/bulk_ingest_candles.py');
  if (!fs.existsSync(python)) throw new Error('Freqtrade Python runtime is missing; run npm run freqtrade:install first.');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(python, [script], { cwd: projectRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Local Freqtrade ingest exited with code ${code}`));
    });
  });
}

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
  .option('--exchange <name>', 'exchange name', process.env.FREQTRADE__EXCHANGE__NAME || 'binance')
  .option('--pairs <list>', 'comma-separated pairs', defaultPairs)
  .option('--timeframes <list>', 'comma-separated candle timeframes', defaultTimeframes)
  .option('--trading-mode <mode>', 'spot|futures|margin', process.env.FREQTRADE_TRADING_MODE || 'futures')
  .option('--data-format <format>', 'json|feather|parquet', 'parquet')
  .option('--timerange <range>', 'e.g. 20240101-20241231')
  .option('--local', 'run directly on this machine; does not require Redis or FREQTRADE_ENABLED')
  .action(async (opts: Record<string, string | boolean>) => {
    try {
      const body: any = {
        exchange: String(opts.exchange),
        pairs: String(opts.pairs).split(',').map((s: string) => s.trim()),
        timeframes: String(opts.timeframes).split(',').map((s: string) => s.trim()),
        tradingMode: String(opts.tradingMode),
        dataFormat: String(opts.dataFormat),
      };
      const timerange = parseTimerange(String(opts.timerange || ''));
      if (timerange) body.timerange = timerange;
      if (opts.local) {
        await runLocalDownload(body);
        return;
      }
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
  .option('--pairs <list>', 'comma-separated pairs', defaultPairs)
  .option('--timeframe <tf>', 'candle timeframe', '1h')
  .option('--wallet <n>', 'dry-run wallet USDT', '10000')
  .option('--local', 'run directly on this machine; does not require Redis or FREQTRADE_ENABLED')
  .action(async (opts: Record<string, string | boolean>) => {
    try {
      const body: any = {
        strategy: String(opts.strategy),
        pairs: String(opts.pairs).split(',').map((s: string) => s.trim()),
        timeframe: String(opts.timeframe || '1h'),
        dryRunWallet: parseFloat(String(opts.wallet)) || 10000,
      };
      const timerange = parseTimerange(String(opts.timerange || ''));
      if (timerange) body.timerange = timerange;
      if (opts.local) {
        await runLocalBacktest(body);
        return;
      }
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
  .option('--local', 'run directly on this machine; does not require Redis or FREQTRADE_ENABLED')
  .action(async (opts: { local?: boolean }) => {
    try {
      if (opts.local) {
        await runLocalIngest();
        return;
      }
      const result = await apiPost('/freqtrade/ingest');
      console.log(chalk.green('Ingest result:'), result.message || 'OK');
    } catch (e: any) {
      console.error(chalk.red(`Cannot reach bot: ${e.message}`));
      process.exitCode = 1;
    }
  });
