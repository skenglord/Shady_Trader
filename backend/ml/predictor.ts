import { runQuery } from '../database.js';
import { extractFeatures, predict, PredictResponse } from './python_bridge.js';
import { logger } from '../logging/logger.js';

export interface MLPrediction {
  probability: number;
  direction: 'buy' | 'sell';
  topFeatures: [string, number][];
  modelPath: string;
  regime: string;
  fallback: boolean;
}

const modelPathCache = new Map<string, string>();

async function getModelPath(symbol: string, regime: string): Promise<string | null> {
  const key = `${symbol}_${regime}`;
  if (modelPathCache.has(key)) return modelPathCache.get(key)!;

  const rows = await runQuery<{ model_path: string }>(
    `SELECT model_path FROM ml_models
     WHERE symbol = ? AND regime = ? AND is_active = 1
     ORDER BY trained_at DESC LIMIT 1`,
    [symbol, regime]
  );

  if (!rows.length) return null;
  modelPathCache.set(key, rows[0].model_path);
  return rows[0].model_path;
}

export async function getPrediction(
  df: Record<string, number>[],
  symbol: string,
  regime: string
): Promise<MLPrediction> {
  const fallbackResult: MLPrediction = {
    probability: 0.5,
    direction: 'buy',
    topFeatures: [],
    modelPath: '',
    regime,
    fallback: true
  };

  if (process.env.ML_ENABLED !== 'true') return fallbackResult;

  const modelPath = await getModelPath(symbol, regime);
  if (!modelPath) {
    logger.warn(`[predictor] No trained model for ${symbol}/${regime}`);
    return fallbackResult;
  }

  try {
    const recentCandles = df.slice(-50);
    const featureResult = await extractFeatures(recentCandles);

    if (featureResult.error || !featureResult.features.length) {
      logger.warn('[predictor] Feature extraction failed:', featureResult.error);
      return fallbackResult;
    }

    const latestFeatures = featureResult.features[featureResult.features.length - 1];

    const response: PredictResponse = await predict({
      features: latestFeatures,
      symbol,
      regime,
      model_path: modelPath
    });

    if (response.error) {
      logger.warn('[predictor] Inference error:', response.error);
      return fallbackResult;
    }

    return {
      probability: response.probability,
      direction: response.direction,
      topFeatures: response.top_features,
      modelPath,
      regime,
      fallback: false
    };

  } catch (err) {
    logger.error('[predictor] Unexpected error:', err);
    return fallbackResult;
  }
}

export async function logPrediction(
  symbol: string,
  regime: string,
  candleTime: number,
  prediction: MLPrediction,
  gemmaAdjustment: number,
  finalScore: number
): Promise<void> {
  await runQuery(
    `INSERT OR IGNORE INTO ml_predictions
       (symbol, regime, candle_time, xgb_probability, gemma_adjustment,
        final_score, predicted_direction, top_features)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      symbol, regime,
      new Date(candleTime).toISOString(),
      prediction.probability,
      gemmaAdjustment,
      finalScore,
      prediction.direction,
      JSON.stringify(prediction.topFeatures)
    ]
  );
}

export async function reconcilePredictions(symbol: string): Promise<void> {
  const unresolved = await runQuery<{ id: number; candle_time: string; predicted_direction: string }>(
    `SELECT id, candle_time, predicted_direction FROM ml_predictions
     WHERE symbol = ? AND actual_direction IS NULL
     AND candle_time < datetime('now', '-2 hours')
     ORDER BY candle_time ASC LIMIT 500`,
    [symbol]
  );

  for (const row of unresolved) {
    const candles = await runQuery<{ open: number; close: number }>(
      `SELECT open, close FROM candles
       WHERE symbol = ? AND time >= ? ORDER BY time ASC LIMIT 2`,
      [symbol, new Date(row.candle_time).getTime()]
    );

    if (candles.length < 1) continue;

    const actual_return = (candles[0].close - candles[0].open) / candles[0].open;
    const actual_direction = actual_return > 0 ? 'buy' : 'sell';
    const was_correct = actual_direction === row.predicted_direction ? 1 : 0;

    await runQuery(
      `UPDATE ml_predictions
       SET actual_direction = ?, actual_return = ?, was_correct = ?
       WHERE id = ?`,
      [actual_direction, actual_return, was_correct, row.id]
    );
  }
}