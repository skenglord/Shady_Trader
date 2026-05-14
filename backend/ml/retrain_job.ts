import { Worker, ConnectionOptions } from 'bullmq';
import { spawn } from 'child_process';
import path from 'path';
import { runQuery } from '../database.js';
import { logger } from '../logging/logger.js';

interface RetrainJobData {
  symbol: string;
  regime: string;
}

interface TrainReport {
  model_path: string;
  symbol: string;
  regime: string;
  training_rows: number;
  holdout_accuracy: number;
  holdout_precision: number;
  holdout_recall: number;
  feature_count: number;
  error?: string;
}

async function fetchCandlesForTraining(symbol: string): Promise<Record<string, number>[]> {
  return runQuery<Record<string, number>>(
    `SELECT time, open, high, low, close, volume
     FROM candles
     WHERE symbol = ? AND timeframe = '5m'
     ORDER BY time ASC`,
    [symbol]
  );
}

async function runPythonTrainer(
  candleRows: Record<string, number>[],
  symbol: string,
  regime: string
): Promise<TrainReport> {
  const pythonBin = process.env.ML_PYTHON_BIN ?? 'python3';
  const modelsDir = process.env.ML_MODELS_DIR ?? './models';
  const scriptPath = path.join(__dirname, 'model_trainer.py');

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, [
      scriptPath,
      '--symbol', symbol,
      '--regime', regime,
      '--output-dir', modelsDir,
    ], { cwd: process.cwd() });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.stdin.write(JSON.stringify(candleRows));
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Retrain timed out for ${symbol}/${regime}`));
    }, 10 * 60 * 1000);

    proc.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Trainer exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as TrainReport);
      } catch {
        reject(new Error(`Invalid JSON from trainer: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function persistModelMetadata(report: TrainReport): Promise<void> {
  await runQuery(
    `UPDATE ml_models SET is_active = 0
     WHERE symbol = ? AND regime = ?`,
    [report.symbol, report.regime]
  );

  await runQuery(
    `INSERT INTO ml_models
       (regime, symbol, model_path, feature_count, accuracy,
        precision_score, recall_score, training_rows, trained_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)`,
    [
      report.regime,
      report.symbol,
      report.model_path,
      report.feature_count,
      report.holdout_accuracy,
      report.holdout_precision,
      report.holdout_recall,
      report.training_rows,
    ]
  );

  logger.info(
    `[retrain] ${report.symbol}/${report.regime} saved. ` +
    `Accuracy: ${(report.holdout_accuracy * 100).toFixed(1)}% ` +
    `on ${report.training_rows.toLocaleString()} rows.`
  );
}

export function createRetrainWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker<RetrainJobData>(
    'ml-retrain',
    async (job) => {
      const { symbol, regime } = job.data;

      logger.info(`[retrain] Starting job: ${symbol}/${regime}`);
      await job.updateProgress(5);

      const candles = await fetchCandlesForTraining(symbol);
      logger.info(`[retrain] ${symbol}/${regime}: ${candles.length} candles fetched`);

      const minRows = Number(process.env.ML_MIN_TRAINING_ROWS ?? '10000');
      if (candles.length < minRows) {
        const msg = `Insufficient data: ${candles.length} rows (need ${minRows})`;
        logger.warn(`[retrain] ${msg}`);
        await runQuery(
          `INSERT INTO audit_system_events (id, event_type, message, timestamp, severity, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), 'ml_retrain_skipped', msg, Date.now(), 'warn', JSON.stringify({ symbol, regime, reason: msg })]
        );
        return { skipped: true, reason: msg };
      }

      await job.updateProgress(20);

      const report = await runPythonTrainer(candles, symbol, regime);
      await job.updateProgress(85);

      if (report.error) {
        throw new Error(`Training failed: ${report.error}`);
      }

      if (report.holdout_accuracy < 0.51) {
        logger.warn(
          `[retrain] ${symbol}/${regime} accuracy ${(report.holdout_accuracy * 100).toFixed(1)}% ` +
          `is below threshold — not deploying.`
        );
        await runQuery(
          `INSERT INTO audit_system_events (id, event_type, message, timestamp, severity, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), 'ml_retrain_rejected', `accuracy below threshold`, Date.now(), 'warn', JSON.stringify({ symbol, regime, accuracy: report.holdout_accuracy })]
        );
        return { deployed: false, reason: 'below_accuracy_threshold', report };
      }

      await persistModelMetadata(report);
      await job.updateProgress(100);

      await runQuery(
        `INSERT INTO audit_system_events (id, event_type, message, timestamp, severity, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), 'ml_retrain_complete', 'model retrained', Date.now(), 'info', JSON.stringify({
          symbol, regime,
          accuracy: report.holdout_accuracy,
          training_rows: report.training_rows,
          model_path: report.model_path
        })]
      );

      return { deployed: true, report };
    },
    {
      connection,
      concurrency: 1,
      limiter: {
        max: 2,
        duration: 600_000
      }
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(`[retrain] Job ${job.id} complete:`, result);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[retrain] Job ${job?.id} failed:`, err);
  });

  return worker;
}