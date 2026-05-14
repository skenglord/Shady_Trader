import { MLPrediction } from './predictor.js';

export interface EnsembleInput {
  mlPrediction: MLPrediction;
  gemmaAdjustment: number;
  regimeConfidence: number;
  regimeName: string;
  cachedSentiment: number;
}

export interface EnsembleResult {
  finalScore: number;
  xgbComponent: number;
  gemmaComponent: number;
  regimeComponent: number;
  sentimentComponent: number;
  shouldTrade: boolean;
  direction: 'buy' | 'sell';
  reasoning: string;
}

const REGIME_WEIGHTS: Record<string, number> = {
  strong_bull: 1.15,
  weak_bull: 1.05,
  sideways: 0.95,
  bear: 0.90,
  uncertain: 0.75
};

export function scoreEnsemble(input: EnsembleInput): EnsembleResult {
  const {
    mlPrediction,
    gemmaAdjustment,
    regimeConfidence,
    regimeName,
    cachedSentiment
  } = input;

  if (mlPrediction.fallback) {
    return {
      finalScore: 0.5,
      xgbComponent: 0.5,
      gemmaComponent: 0.0,
      regimeComponent: 1.0,
      sentimentComponent: 0.0,
      shouldTrade: false,
      direction: 'buy',
      reasoning: 'ML model unavailable — rule-based fallback active'
    };
  }

  const xgbBase = mlPrediction.probability;
  const gemmaAdjusted = xgbBase * (1 + gemmaAdjustment);

  const regimeWeight = REGIME_WEIGHTS[regimeName] ?? 1.0;
  const regimeNorm = regimeConfidence / 100;
  const effectiveRegimeWeight = 1 + (regimeWeight - 1) * regimeNorm;

  const regimeAdjusted = gemmaAdjusted * effectiveRegimeWeight;
  const sentimentFactor = 1 + (cachedSentiment * 0.05);
  const finalRaw = regimeAdjusted * sentimentFactor;

  const finalScore = Math.max(0.01, Math.min(0.99, finalRaw));
  const direction: 'buy' | 'sell' = finalScore > 0.5 ? 'buy' : 'sell';

  const threshold = Number(process.env.ML_CONFIDENCE_THRESHOLD ?? '0.58');
  const shouldTrade = Math.abs(finalScore - 0.5) > Math.abs(threshold - 0.5);

  const reasoning =
    `XGBoost: ${(xgbBase * 100).toFixed(1)}% → ` +
    `Gemma adj: ${gemmaAdjustment >= 0 ? '+' : ''}${(gemmaAdjustment * 100).toFixed(1)}% → ` +
    `Regime(${regimeName}): ×${effectiveRegimeWeight.toFixed(2)} → ` +
    `Sentiment: ×${sentimentFactor.toFixed(2)} → ` +
    `Final: ${(finalScore * 100).toFixed(1)}%`;

  return {
    finalScore,
    xgbComponent: xgbBase,
    gemmaComponent: gemmaAdjustment,
    regimeComponent: effectiveRegimeWeight,
    sentimentComponent: sentimentFactor,
    shouldTrade,
    direction,
    reasoning
  };
}