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

  const rows = await runQuery(
    `SELECT COUNT(*) as count FROM ml_models WHERE is_active = 1`
  );
  const modelCount = rows[0]?.count ?? 0;

  let gemmaCache = false;
  try {
    // Optional: probe Redis for the cached gemma adjustment. If Redis is
    // unavailable or the export shape changes, the gemmaCache flag stays
    // false (the ML cache is a soft optimization, not a hard requirement).
    const { getServiceManager, getRedis } = await import('../stateless-manager.js') as any;
    if (typeof getRedis === 'function' && typeof getServiceManager === 'function') {
      const redis = getRedis();
      if (redis) {
        const mgr = getServiceManager(redis, 'ml');
        const raw = await mgr.get('gemma:adjustment');
        gemmaCache = raw !== null;
      }
    }
  } catch { /* Redis offline — not fatal */ }

  return {
    enabled,
    modelsReady: modelCount > 0,
    gemmaCache,
    modelCount
  };
}