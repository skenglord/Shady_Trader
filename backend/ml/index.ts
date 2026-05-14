export type { MLPrediction } from './predictor.js';
export { getPrediction, logPrediction, reconcilePredictions } from './predictor.js';

export type { EnsembleInput, EnsembleResult } from './ensemble_scorer.js';
export { scoreEnsemble } from './ensemble_scorer.js';

export type { MetaLabelContext } from './gemma_adjuster.js';
export { startGemmaAdjusterLoop, stopGemmaAdjusterLoop, getCachedAdjustment } from './gemma_adjuster.js';

export type { PredictRequest, PredictResponse, FeatureRequest, FeatureResponse } from './python_bridge.js';
export { extractFeatures, predict } from './python_bridge.js';

export type { ExitConfig, ExitEvent, ExitReason } from '../strategy/candle_exit_manager.js';
export { CandleExitManager, parseExitConfig } from '../strategy/candle_exit_manager.js';

export async function getMLHealth(): Promise<{
  enabled: boolean;
  modelsReady: boolean;
  gemmaCache: boolean;
  modelCount: number;
}> {
  const { runQuery } = await import('../database.js');
  const { getCachedAdjustment } = await import('./gemma_adjuster.js');

  const enabled = process.env.ML_ENABLED === 'true';

  if (!enabled) {
    return { enabled: false, modelsReady: false, gemmaCache: false, modelCount: 0 };
  }

  const rows = await runQuery<{ count: number }>(
    `SELECT COUNT(*) as count FROM ml_models WHERE is_active = 1`
  );
  const modelCount = rows[0]?.count ?? 0;

  let gemmaCache = false;
  try {
    const { StatelessManager } = await import('../stateless-manager.js');
    const raw = await StatelessManager.get('ml:gemma:adjustment');
    gemmaCache = raw !== null;
  } catch { /* Redis offline — not fatal */ }

  return {
    enabled,
    modelsReady: modelCount > 0,
    gemmaCache,
    modelCount
  };
}