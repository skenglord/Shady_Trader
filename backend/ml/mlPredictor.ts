// backend/ml/mlPredictor.ts — Block 15: ONNX ML inference (stub)
//
// Production ML inference — ONNX only. No Python bridge. When a model is
// unavailable, returns null. Callers treat null as "no ML opinion — proceed
// with rule-based exit logic."

import { logger } from '../logging/logger.js';
import type { CompositeRegime } from '../types/regime.js';

const MODEL_DIR = process.env.ML_MODELS_DIR ?? '.models';
const sessions  = new Map<string, any>();

export async function loadModels(): Promise<void> {
  // Stub: in production, load all .onnx files from MODEL_DIR
  logger.info('ML models loading deferred (ONNX runtime not installed)', { service: 'mlPredictor' });
}

/**
 * Predict probability that the current trade exits at TP (not SL).
 * Returns null when model is unavailable — fail-open.
 */
export async function predictExitProbability(
  symbol: string,
  regime: CompositeRegime,
  features: Float32Array
): Promise<number | null> {
  const key = `${symbol}_${regime}`;
  const session = sessions.get(key);
  if (!session) {
    logger.debug('No model for key — skipping inference', { service: 'mlPredictor', key });
    return null;
  }
  // Stub: in production, run ort.InferenceSession.run(tensor)
  return null;
}
