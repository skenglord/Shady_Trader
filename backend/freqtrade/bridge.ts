/**
 * FreqtradeBridge — typed TypeScript module that spawns Freqtrade CLI
 * processes, captures stdout, surfaces errors, and returns structured
 * results. Phase 2 of the Freqtrade integration plan.
 *
 * Design notes
 * ------------
 * - Uses `child_process.spawn` (NOT `exec`/`execFile`) so we can capture
 *   stdout/stderr in real time and propagate SIGTERM cancellation.
 * - Long-running calls (`downloadData`, `runBacktest`) stream progress via
 *   a returned `AsyncIterable<DownloadProgress>` AND accept an optional
 *   `onProgress` callback (fire-and-forget). Either can be used.
 * - Stdout is passed through a regex-based scanner (B8). Any line matching
 *   `/WARNING|ERROR|Traceback/i` is collected into `result.warnings` and
 *   causes `result.success = false` in the result metadata.
 * - Backtest commands always receive `--cache none` (B5) to prevent
 *   indicator cache poisoning.
 * - Defaults mirror `backend/freqtrade/start_server.sh` and
 *   `backend/freqtrade/user_data/config.json`.
 * - All emitted logs include: jobId, exchange, duration, exit code.
 */

import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { logger as defaultLogger } from '../logging/logger.js';
import { buildFreqtradeEnv, normalizeFreqtradeTimerange } from './validation.js';

// ──────────────────────────────────────────────────────────────────────
// Public types / Zod schemas
// ──────────────────────────────────────────────────────────────────────

/** Permissive logger contract — accepts the project's structured logger
 *  or any noop shim. */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined
};

/** Time range filter used by both download and backtest. */
const TimerangeSchema = z
  .object({
    start: z.string().optional(),
    end: z.string().optional()
  })
  .strict();

export const DownloadDataRequestSchema = z.object({
  exchange: z.string().min(1),
  pairs: z.array(z.string().min(1)).min(1),
  timeframes: z.array(z.string().min(1)).min(1),
  timerange: TimerangeSchema.optional(),
  tradingMode: z.enum(['spot', 'futures', 'margin']),
  dataFormat: z.enum(['json', 'feather', 'parquet']),
  /** Extra raw args appended verbatim (escape hatch). */
  extraArgs: z.array(z.string()).optional()
});

export type DownloadDataRequest = z.infer<typeof DownloadDataRequestSchema>;

export const RunBacktestRequestSchema = z.object({
  strategy: z.string().min(1),
  timerange: TimerangeSchema.optional(),
  pairs: z.array(z.string().min(1)).min(1),
  timeframe: z.string().min(1),
  dryRunWallet: z.number().positive(),
  fee: z.number().nonnegative().optional(),
  /** Extra raw args appended verbatim. */
  extraArgs: z.array(z.string()).optional()
});

export type RunBacktestRequest = z.infer<typeof RunBacktestRequestSchema>;

/** Strict schema for the portion of the freqtrade backtest-result JSON
 *  we surface. Freqtrade writes more fields, but we only care about the
 *  canonical ones. */
export const BacktestResultSchema = z
  .object({
    strategy: z.string(),
    pair_results: z.array(z.record(z.string(), z.unknown())).optional(),
    total_trades: z.number().nonnegative().optional(),
    wins: z.number().nonnegative().optional(),
    losses: z.number().nonnegative().optional(),
    sharpe: z.number().optional(),
    max_drawdown: z.number().optional(),
    profit_factor: z.number().optional(),
    expectancy: z.number().optional()
  })
  .passthrough();

export type BacktestResult = z.infer<typeof BacktestResultSchema> & {
  warnings: string[];
  metadata: {
    jobId: string;
    exchange: string;
    durationMs: number;
    exitCode: number;
    success: boolean;
    exportPath?: string;
  };
};

/** Progress event emitted by `downloadData` for each parsed stdout line. */
export type DownloadProgress = {
  jobId: string;
  exchange: string;
  /** Raw line from freqtrade stdout. */
  line: string;
  /** Best-effort classification. */
  type: 'info' | 'warning' | 'error' | 'progress';
  /** Cumulative count of pairs that have completed (heuristic). */
  pairsCompleted: number;
  pairsTotal: number;
  timestamp: number;
};

/** Per-pair progress callback (fire-and-forget). */
export type DownloadProgressCallback = (progress: DownloadProgress) => void;

export interface FreqtradeBridgeOptions {
  /** Absolute path to the freqtrade virtualenv dir. */
  venvDir?: string;
  /** Absolute path to the freqtrade user_data dir (contains config.json
   *  and data/). */
  userDataDir?: string;
  /** Path to the freqtrade config file (relative to `userDataDir` if not
   *  absolute). */
  configPath?: string;
  /** Logger used for bridge events. Defaults to the project logger. */
  logger?: Logger;
  /** Override the timeout for `downloadData` in ms. Default 30 minutes. */
  downloadTimeoutMs?: number;
  /** Override the timeout for `runBacktest` in ms. Default 10 minutes. */
  backtestTimeoutMs?: number;
  /** Override the path to the freqtrade binary. Defaults to
   *  `<venvDir>/bin/freqtrade`. Useful for tests. */
  freqtradeBin?: string;
  /** Optional custom spawn function override for testing. */
  spawn?: typeof spawn;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

/** Warning regex from bottleneck B8. Captures WARNING/ERROR/Traceback. */
const WARNING_LINE_REGEX = /(?:^|\s)(?:WARNING|ERROR|Traceback)(?:\s|$|:)/i;

/** Holds the set of active child processes for `cancel(jobId)`. */
const activeJobs = new Map<string, ChildProcess>();

/** Resolves a venv path to the absolute freqtrade binary path. */
function defaultFreqtradeBin(venvDir: string): string {
  return path.join(venvDir, 'bin', 'freqtrade');
}

/** Build a `freqtrade <subcommand> ...` argv. Filters out undefined. */
function buildArgs(parts: Array<string | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === undefined || part === null) continue;
    if (Array.isArray(part)) {
      for (const p of part) {
        if (p !== undefined && p !== null && p !== '') out.push(p);
      }
    } else if (part !== '') {
      out.push(part);
    }
  }
  return out;
}

/** Convert a Readable stream into an async iterable of lines. */
async function* readLines(
  stream: NodeJS.ReadableStream | null | undefined
): AsyncGenerator<string> {
  if (!stream) return;
  let buffer = '';
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) yield line;
      idx = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) {
    const line = buffer.replace(/\r$/, '');
    if (line.length > 0) yield line;
  }
}

/** Categorise a freqtrade stdout line for progress purposes. */
function classifyLine(line: string): 'info' | 'warning' | 'error' | 'progress' {
  if (WARNING_LINE_REGEX.test(line)) {
    if (/^ERROR|Traceback/i.test(line.trim())) return 'error';
    return 'warning';
  }
  // Freqtrade prints "Downloading pair X of Y: BTC/USDT 1h" style lines
  if (/downloading pair|downloaded|fetching|progress/i.test(line)) return 'progress';
  return 'info';
}

/** Collect warning/error lines from a chunk of freqtrade output. */
export function collectWarnings(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (WARNING_LINE_REGEX.test(line)) out.push(line);
  }
  return out;
}

/** Parse the stdout of `freqtrade list-strategies` into a list of class
 *  names. The output is one class name per line; lines that look like
 *  log noise (anything containing `INFO`, `WARNING`, `Using`, or empty
 *  strings) are ignored. */
export function parseStrategyList(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (WARNING_LINE_REGEX.test(line)) continue;
    if (/^(INFO|DEBUG|VERBOSE)\b/i.test(line)) continue;
    if (/^Using\b/i.test(line)) continue;
    // Heuristic: strategy class names match PascalCase. This is what
    // freqtrade's own example output looks like.
    if (/^[A-Z][A-Za-z0-9_]*$/.test(line)) {
      out.push(line);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// FreqtradeBridge
// ──────────────────────────────────────────────────────────────────────

export class FreqtradeBridge {
  private readonly venvDir: string;
  private readonly userDataDir: string;
  private readonly configPath: string;
  private readonly freqtradeBin: string;
  private readonly logger: Logger;
  private readonly downloadTimeoutMs: number;
  private readonly backtestTimeoutMs: number;
  private readonly spawnFn: typeof spawn;

  constructor(opts: FreqtradeBridgeOptions = {}) {
    // Resolve relative to the bridge file's location so callers don't have
    // to pass absolute paths from CWD.
    const bridgeDir = path.dirname(new URL(import.meta.url).pathname);
    const defaultUserData = path.resolve(bridgeDir, 'user_data');
    const defaultVenv = path.resolve(bridgeDir, 'venv');
    const defaultConfig = path.resolve(defaultUserData, 'config.json');

    this.venvDir = opts.venvDir ?? defaultVenv;
    this.userDataDir = opts.userDataDir ?? defaultUserData;
    this.configPath = opts.configPath
      ? (path.isAbsolute(opts.configPath) ? opts.configPath : path.resolve(this.userDataDir, opts.configPath))
      : defaultConfig;
    this.freqtradeBin = opts.freqtradeBin ?? defaultFreqtradeBin(this.venvDir);
    this.logger = opts.logger ?? (defaultLogger as unknown as Logger) ?? noopLogger;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? 30 * 60 * 1000; // 30 min
    this.backtestTimeoutMs = opts.backtestTimeoutMs ?? 10 * 60 * 1000; // 10 min
    this.spawnFn = opts.spawn ?? spawn;
  }

  /** Resolved absolute config path. */
  public getConfigPath(): string {
    return this.configPath;
  }

  /** Resolved user-data dir. */
  public getUserDataDir(): string {
    return this.userDataDir;
  }

  // ── ping ────────────────────────────────────────────────────────────

  /** Shell out to `freqtrade --version`. Returns true on exit 0. */
  public async ping(): Promise<boolean> {
    const jobId = randomUUID();
    const start = Date.now();
    const args = ['--version'];
    try {
      const exitCode = await this.spawnAndCollect(jobId, args, { timeoutMs: 10_000, capture: true });
      const duration = Date.now() - start;
      this.logger.info('freqtrade --version completed', {
        jobId,
        durationMs: duration,
        exitCode,
        exchange: 'n/a'
      });
      return exitCode === 0;
    } catch (err) {
      const duration = Date.now() - start;
      this.logger.error('freqtrade --version failed', {
        jobId,
        durationMs: duration,
        exchange: 'n/a',
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }

  // ── checkPythonVersion ────────────────────────────────────────────

  /**
   * B10 mitigation: verify that the Python in the venv meets the minimum
   * version requirement (≥ 3.11). Freqtrade 2026.x requires Python 3.11+.
   *
   * Returns `{ ok: true, version: '3.11.x' }` on success, or
   * `{ ok: false, version: '', error: '...' }` on failure.
   */
  public async checkPythonVersion(): Promise<{ ok: boolean; version: string; error?: string }> {
    const pythonBin = path.join(this.venvDir, 'bin', 'python3');
    // Fall back to system python3 if venv python doesn't exist yet
    const bin = existsSync(pythonBin) ? pythonBin : 'python3';
    const jobId = randomUUID();

    return new Promise((resolve) => {
      const proc = this.spawnFn(bin, ['--version'], {
        stdio: 'pipe',
        env: process.env
      });
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
      proc.on('error', (err) => {
        resolve({ ok: false, version: '', error: err.message });
      });
      proc.on('close', (code) => {
        // python3 --version prints to stdout (3.11+) or stderr (some 3.x)
        const raw = (
          Buffer.concat(chunks).toString('utf8') +
          Buffer.concat(stderrChunks).toString('utf8')
        ).trim();
        // Expected: "Python 3.11.9" or "Python 3.12.0"
        const match = raw.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
        if (!match) {
          resolve({ ok: false, version: raw, error: `Unexpected python version output: ${raw}` });
          return;
        }
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        const version = `${match[1]}.${match[2]}.${match[3]}`;
        const ok = code === 0 && (major > 3 || (major === 3 && minor >= 11));
        this.logger.info('python version check', { jobId, version, ok });
        if (!ok) {
          resolve({
            ok: false,
            version,
            error: `Python ${version} detected; freqtrade 2026.x requires ≥ 3.11`
          });
        } else {
          resolve({ ok: true, version });
        }
      });
    });
  }



  /** Run `freqtrade list-strategies -c <config> --userdir <userdir>` and
   *  return the discovered strategy class names. Empty output → []. */
  public async listStrategies(): Promise<string[]> {
    const jobId = randomUUID();
    const start = Date.now();
    const args = buildArgs([
      'list-strategies',
      '-c', this.configPath,
      '--userdir', this.userDataDir
    ]);
    const result = await this.runAndCaptureStdout(jobId, args, { timeoutMs: 30_000, exchange: 'n/a' });
    const duration = Date.now() - start;
    this.logger.info('freqtrade list-strategies completed', {
      jobId,
      durationMs: duration,
      exitCode: result.exitCode,
      exchange: 'n/a',
      stdoutLines: result.stdout.length
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `freqtrade list-strategies exited with code ${result.exitCode}` +
          (result.stderr ? `\nstderr: ${result.stderr.slice(0, 2000)}` : '')
      );
    }
    return parseStrategyList(result.stdout.join('\n'));
  }

  // ── downloadData ───────────────────────────────────────────────────

  /**
   * Run `freqtrade download-data ...` and stream progress. Returns an
   * `AsyncIterable<DownloadProgress>` so callers can `for await…` or
   * `.next()`. The iterable completes when the child process exits; the
   * final value carries the exit code and warnings in
   * `result.metadata`.
   *
   * The optional `onProgress` callback is invoked for the same events
   * (fire-and-forget; errors are swallowed).
   */
  public async downloadData(
    req: DownloadDataRequest,
    onProgress?: DownloadProgressCallback
  ): Promise<AsyncIterable<DownloadProgress>> {
    const parsed = DownloadDataRequestSchema.parse(req);
    const jobId = randomUUID();
    const timerange = normalizeFreqtradeTimerange(parsed.timerange, 'download-data timerange');

    const args = buildArgs([
      'download-data',
      '--exchange', parsed.exchange,
      '--pairs', parsed.pairs,
      '--timeframes', parsed.timeframes,
      '--timerange', timerange.start === timerange.end ? undefined : `${timerange.start}-${timerange.end}`,
      '--trading-mode', parsed.tradingMode,
      '--data-format-ohlcv', parsed.dataFormat,
      '-c', this.configPath,
      '--userdir', this.userDataDir,
      parsed.extraArgs
    ]);

    return this.streamWithProgress(jobId, args, {
      timeoutMs: this.downloadTimeoutMs,
      exchange: parsed.exchange,
      pairsTotal: parsed.pairs.length,
      onProgress
    });
  }

  // ── runBacktest ────────────────────────────────────────────────────

  /** Run `freqtrade backtesting ... --export trades --export-filename
   *  <temp>` and parse the resulting JSON. Always passes `--cache none`
   *  (B5 mitigation). The temp file is deleted on success; on failure the
   *  path is preserved in `result.metadata.exportPath` for inspection. */
  public async runBacktest(req: RunBacktestRequest): Promise<BacktestResult> {
    const parsed = RunBacktestRequestSchema.parse(req);
    const jobId = randomUUID();
    const start = Date.now();
    const timerange = normalizeFreqtradeTimerange(parsed.timerange, 'backtest timerange');

    // Freqtrade writes to a relative dir, so use an absolute temp file
    // to avoid CWD surprises.
    const exportFilename = path.join(
      os.tmpdir(),
      `freqtrade-backtest-${jobId}.json`
    );

    const args = buildArgs([
      'backtesting',
      '--strategy', parsed.strategy,
      '--timerange', `${timerange.start}-${timerange.end}`,
      '--timeframe', parsed.timeframe,
      '--pairs', parsed.pairs,
      '--dry-run-wallet', String(parsed.dryRunWallet),
      '--fee', parsed.fee !== undefined ? String(parsed.fee) : undefined,
      '--export', 'trades',
      '--export-filename', exportFilename,
      '--cache', 'none', // B5: never poison the indicator cache
      '-c', this.configPath,
      '--userdir', this.userDataDir,
      parsed.extraArgs
    ]);

    const result = await this.runAndCaptureStdout(jobId, args, {
      timeoutMs: this.backtestTimeoutMs,
      exchange: 'n/a' // strategy-scoped, not exchange-scoped
    });
    const duration = Date.now() - start;

    const warnings = collectWarnings([...result.stdout, ...result.stderr]);
    const success = result.exitCode === 0 && warnings.length === 0;
    const exchange = 'n/a';

    this.logger.info('freqtrade backtesting completed', {
      jobId,
      exchange,
      durationMs: duration,
      exitCode: result.exitCode,
      warnings: warnings.length,
      success
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `freqtrade backtesting exited with code ${result.exitCode}` +
          (warnings.length > 0 ? `\nwarnings:\n  ${warnings.join('\n  ')}` : '') +
          (result.stderr ? `\nstderr: ${result.stderr.slice(0, 4000)}` : '')
      );
    }

    // Read & parse the export. Some Freqtrade versions emit a
    // backtest-result-*.json that the engine writes alongside; the
    // explicit --export-filename is authoritative.
    if (!existsSync(exportFilename)) {
      const fallback = await this.findLastResultJson();
      if (!fallback) {
        throw new Error(
          `freqtrade backtesting did not produce ${exportFilename}` +
            (result.stderr ? `\nstderr: ${result.stderr.slice(0, 2000)}` : '')
        );
      }
      const parsedExport = await readAndParseJson(fallback);
      if (parsedExport.ok === false) {
        throw new Error(`failed to parse ${fallback}: ${parsedExport.error}`);
      }
      return withMetadata(parsedExport.data, {
        jobId, exchange, durationMs: duration, exitCode: result.exitCode, success, warnings, exportPath: fallback
      });
    }

    const parsedExport = await readAndParseJson(exportFilename);
    if (parsedExport.ok === false) {
      throw new Error(`failed to parse ${exportFilename}: ${parsedExport.error}`);
    }

    // Best-effort cleanup of the temp file.
    void fs.unlink(exportFilename).catch(() => undefined);

    return withMetadata(parsedExport.data, {
      jobId, exchange, durationMs: duration, exitCode: result.exitCode, success, warnings, exportPath: exportFilename
    });
  }

  // ── cancel ─────────────────────────────────────────────────────────

  /** Send SIGTERM to the child process with the given jobId. Returns
   *  true if a matching process was found and signalled. */
  public async cancel(jobId: string): Promise<boolean> {
    const proc = activeJobs.get(jobId);
    if (!proc || proc.killed || proc.exitCode !== null) {
      activeJobs.delete(jobId);
      return false;
    }
    try {
      proc.kill('SIGTERM');
      this.logger.info('freqtrade job cancelled', {
        jobId,
        exchange: 'n/a',
        exitCode: -1,
        signal: 'SIGTERM'
      });
      // Wait briefly for the process to actually exit so callers can
      // trust the contract. We don't fail the cancel if it takes a
      // moment; SIGKILL after 5s as a safety net.
      const exited = await waitForExit(proc, 5000);
      if (!exited && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch { /* swallow */ }
      }
      activeJobs.delete(jobId);
      return true;
    } catch (err) {
      this.logger.error('freqtrade job cancel failed', {
        jobId,
        exchange: 'n/a',
        error: err instanceof Error ? err.message : String(err)
      });
      activeJobs.delete(jobId);
      return false;
    }
  }

  // ── low-level spawn helpers ────────────────────────────────────────

  /** Spawn a child, collect all stdout/stderr into strings, and resolve
   *  with the exit code (or reject on spawn error). */
  private runAndCaptureStdout(
    jobId: string,
    args: string[],
    opts: { timeoutMs: number; exchange: string }
  ): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnChild(args, jobId);
      const stdout: string[] = [];
      const stderr: string[] = [];
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        activeJobs.delete(jobId);
      };

      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');

      const readStdout = async () => {
        for await (const line of readLines(proc.stdout)) stdout.push(line);
      };
      const readStderr = async () => {
        for await (const line of readLines(proc.stderr)) stderr.push(line);
      };

      const exitCodePromise = new Promise<number>((res) => {
        proc.on('close', (code) => res(code ?? 0));
        proc.on('error', (err) => {
          cleanup();
          reject(err);
        });
      });

      Promise.all([readStdout(), readStderr(), exitCodePromise])
        .then(([_, __, exitCode]) => {
          cleanup();
          resolve({ exitCode, stdout, stderr });
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });

      if (opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch { /* swallow */ }
          // Give it 5s to exit gracefully, then SIGKILL.
          setTimeout(() => {
            if (proc.exitCode === null) {
              try { proc.kill('SIGKILL'); } catch { /* swallow */ }
            }
          }, 5000).unref();
        }, opts.timeoutMs);
        timer.unref();
      }
    });
  }

  private spawnAndCollect(
    jobId: string,
    args: string[],
    opts: { timeoutMs: number; capture?: boolean }
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnChild(args, jobId);
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        activeJobs.delete(jobId);
      };

      const drainStdout = async () => {
        if (opts.capture) {
          proc.stdout?.resume();
        } else {
          for await (const _ of readLines(proc.stdout)) { /* drain */ }
        }
      };
      const drainStderr = async () => {
        if (opts.capture) {
          proc.stderr?.resume();
        } else {
          for await (const _ of readLines(proc.stderr)) { /* drain */ }
        }
      };

      const exitCodePromise = new Promise<number>((res) => {
        proc.on('close', (code) => res(code ?? 0));
        proc.on('error', (err) => {
          cleanup();
          reject(err);
        });
      });

      Promise.all([drainStdout(), drainStderr(), exitCodePromise])
        .then(([_, __, exitCode]) => {
          cleanup();
          resolve(exitCode);
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
      if (opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch { /* swallow */ }
        }, opts.timeoutMs);
        timer.unref();
      }
    });
  }

  /** Spawn a child and return an AsyncIterable of progress events. The
   *  iterable completes when the child exits. The final `type` and
   *  metadata are derived from the exit code. */
  private async *streamWithProgress(
    jobId: string,
    args: string[],
    opts: {
      timeoutMs: number;
      exchange: string;
      pairsTotal: number;
      onProgress?: DownloadProgressCallback;
    }
  ): AsyncGenerator<DownloadProgress> {
    const proc = this.spawnChild(args, jobId);
    const start = Date.now();
    let pairsCompleted = 0;

    // Timeout: SIGTERM, then SIGKILL after grace.
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* swallow */ }
        setTimeout(() => {
          if (proc.exitCode === null) {
            try { proc.kill('SIGKILL'); } catch { /* swallow */ }
          }
        }, 5000).unref();
      }, opts.timeoutMs);
      timer.unref();
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      activeJobs.delete(jobId);
    };

    try {
      for await (const line of readLines(proc.stdout)) {
        const type = classifyLine(line);
        // Heuristic: increment the completed-pair counter when we see
        // a progress line that mentions a known pair.
        if (type === 'progress') {
          pairsCompleted += 1;
        }
        const event: DownloadProgress = {
          jobId,
          exchange: opts.exchange,
          line,
          type,
          pairsCompleted: Math.min(pairsCompleted, opts.pairsTotal),
          pairsTotal: opts.pairsTotal,
          timestamp: Date.now()
        };
        if (opts.onProgress) {
          try { opts.onProgress(event); } catch { /* swallow callback errors */ }
        }
        yield event;
      }
      for await (const line of readLines(proc.stderr)) {
        const type = classifyLine(line);
        const event: DownloadProgress = {
          jobId,
          exchange: opts.exchange,
          line,
          type,
          pairsCompleted: Math.min(pairsCompleted, opts.pairsTotal),
          pairsTotal: opts.pairsTotal,
          timestamp: Date.now()
        };
        if (opts.onProgress) {
          try { opts.onProgress(event); } catch { /* swallow */ }
        }
        yield event;
      }
    } finally {
      // Wait for the process to actually close so the caller can rely on
      // the final event being a faithful representation.
      const exitCode: number = await new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
        } else {
          proc.once('close', (code) => resolve(code ?? 0));
        }
      });
      const durationMs = Date.now() - start;
      this.logger.info('freqtrade download-data completed', {
        jobId,
        exchange: opts.exchange,
        durationMs,
        exitCode,
        pairsCompleted
      });
      // Emit a final synthetic line that carries the exit code.
      const finalEvent: DownloadProgress = {
        jobId,
        exchange: opts.exchange,
        line: exitCode === 0 ? 'freqtrade download-data completed' : `freqtrade download-data exited with code ${exitCode}`,
        type: exitCode === 0 ? 'info' : 'error',
        pairsCompleted: Math.min(pairsCompleted, opts.pairsTotal),
        pairsTotal: opts.pairsTotal,
        timestamp: Date.now()
      };
      if (opts.onProgress) {
        try { opts.onProgress(finalEvent); } catch { /* swallow */ }
      }
      yield finalEvent;
      cleanup();
    }
  }

  private spawnChild(args: string[], jobId: string): ChildProcess {
    const proc = this.spawnFn(this.freqtradeBin, args, {
      cwd: this.userDataDir,
      stdio: 'pipe',
      env: buildFreqtradeEnv(),
    });
    activeJobs.set(jobId, proc);
    return proc;
  }

  /** Walk the user_data dir for the latest backtest-result-*.json. */
  private async findLastResultJson(): Promise<string | null> {
    const root = path.join(this.userDataDir, 'backtest_results');
    if (!existsSync(root)) return null;
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      return null;
    }
    const candidates = entries
      .filter((n) => n.startsWith('backtest-result-') && n.endsWith('.json'))
      .map((n) => path.join(root, n));
    if (candidates.length === 0) return null;
    // Pick the most recently modified file.
    let best: { p: string; m: number } | null = null;
    for (const p of candidates) {
      try {
        const stat = await fs.stat(p);
        if (!best || stat.mtimeMs > best.m) best = { p, m: stat.mtimeMs };
      } catch {
        // skip
      }
    }
    return best ? best.p : null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Small utility helpers (kept module-private but exported for tests)
// ──────────────────────────────────────────────────────────────────────

/** Read a JSON file and return either the parsed data or a string
 *  describing the parse error. Never throws. */
export async function readAndParseJson(
  filePath: string
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Wrap a raw parsed export with our metadata envelope. */
export function withMetadata(
  data: unknown,
  meta: {
    jobId: string;
    exchange: string;
    durationMs: number;
    exitCode: number;
    success: boolean;
    warnings: string[];
    exportPath: string;
  }
): BacktestResult {
  const parsed = BacktestResultSchema.parse(data);
  return {
    ...parsed,
    warnings: meta.warnings,
    metadata: {
      jobId: meta.jobId,
      exchange: meta.exchange,
      durationMs: meta.durationMs,
      exitCode: meta.exitCode,
      success: meta.success,
      exportPath: meta.exportPath
    }
  };
}

/** Wait up to `timeoutMs` for a process to exit. Resolves true if the
 *  process exited, false if the timeout elapsed. */
function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(true);
      return;
    }
    const t = setTimeout(() => resolve(false), timeoutMs);
    t.unref();
    proc.once('close', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
