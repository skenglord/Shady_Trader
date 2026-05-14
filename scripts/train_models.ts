import { spawn } from 'child_process';
import path from 'path';
import { runQuery } from '../backend/database.js';
import { logger } from '../backend/logging/logger.js';

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const REGIMES = ['strong_bull', 'weak_bull', 'sideways', 'bear'];
const PYTHON = process.env.ML_PYTHON_BIN ?? 'python3';
const MODELS_DIR = process.env.ML_MODELS_DIR ?? './models';

function labelRegime(row: Record<string, number>): string {
  const { adx, price_change_30d, price_change_7d, vol_ratio, rsi } = row;
  if (adx > 30 && price_change_30d > 0.12 && price_change_7d > 0.03 && vol_ratio > 1.3)
    return 'strong_bull';
  if (price_change_30d < -0.08 || (price_change_7d < -0.05 && rsi < 40))
    return 'bear';
  if (adx < 20 && Math.abs(price_change_30d) < 0.04 && Math.abs(price_change_7d) < 0.015)
    return 'sideways';
  if (price_change_30d > 0.04)
    return 'weak_bull';
  return 'uncertain';
}

async function runPythonTrainer(
  candleJson: string,
  symbol: string,
  regime: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const trainerPath = path.join(process.cwd(), 'backend/ml/model_trainer.py');
    const proc = spawn(PYTHON, [
      trainerPath,
      '--symbol', symbol,
      '--regime', regime,
      '--output-dir', MODELS_DIR
    ], { cwd: process.cwd() });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.stdin.write(candleJson);
    proc.stdin.end();

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Trainer exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Invalid JSON from trainer: ${stdout}`));
      }
    });
  });
}

async function trainForSymbolRegime(symbol: string, regime: string) {
  logger.info(`[train] Starting ${symbol} / ${regime}`);

  const candles = await runQuery<Record<string, number>>(
    `SELECT c.time, c.open, c.high, c.low, c.close, c.volume
     FROM candles c
     WHERE c.symbol = ? AND c.timeframe = '5m'
     ORDER BY c.time ASC`,
    [symbol]
  );

  if (candles.length < 500) {
    logger.warn(`[train] Skipping ${symbol}/${regime}: only ${candles.length} candles`);
    return;
  }

  logger.info(`[train] ${symbol}/${regime}: ${candles.length} candles available`);

  const candleJson = JSON.stringify(candles);
  const report = await runPythonTrainer(candleJson, symbol, regime);

  if (report.error) {
    logger.error(`[train] ${symbol}/${regime} error:`, report.error);
    return;
  }

  await runQuery(
    `UPDATE ml_models SET is_active = 0
     WHERE symbol = ? AND regime = ?`,
    [symbol, regime]
  );

  await runQuery(
    `INSERT INTO ml_models
       (regime, symbol, model_path, feature_count, accuracy,
        precision_score, recall_score, training_rows, trained_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)`,
    [
      regime, symbol,
      report.model_path as string,
      report.feature_count as number,
      report.holdout_accuracy as number,
      report.holdout_precision as number,
      report.holdout_recall as number,
      report.training_rows as number
    ]
  );

  logger.info(
    `[train] ${symbol}/${regime} complete. ` +
    `Accuracy: ${((report.holdout_accuracy as number) * 100).toFixed(1)}% ` +
    `(walk-forward mean: ${((report.walk_forward as Record<string, number>).mean_accuracy * 100).toFixed(1)}%)`
  );
}

async function main() {
  for (const symbol of SYMBOLS) {
    for (const regime of REGIMES) {
      await trainForSymbolRegime(symbol, regime);
    }
  }
  logger.info('[train] All models trained. Check ml_models table for results.');
  process.exit(0);
}

main().catch(e => { logger.error('[train] Fatal:', e); process.exit(1); });