import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert';
import { assignABGroup, evaluateEntryFilter, evaluatePromotionGate } from '../../backend/ml/entryPredictor.js';
import { scoreEnsemble } from '../../backend/ml/ensemble_scorer.js';
import { getMLHealth } from '../../backend/ml/index.js';
import { getPrediction } from '../../backend/ml/predictor.js';

const originalMlEnabled = process.env.ML_ENABLED;
const originalThreshold = process.env.ML_CONFIDENCE_THRESHOLD;

afterEach(() => {
  if (originalMlEnabled === undefined) {
    delete process.env.ML_ENABLED;
  } else {
    process.env.ML_ENABLED = originalMlEnabled;
  }

  if (originalThreshold === undefined) {
    delete process.env.ML_CONFIDENCE_THRESHOLD;
  } else {
    process.env.ML_CONFIDENCE_THRESHOLD = originalThreshold;
  }
});

describe('ML advisory and ensemble components', () => {
  test('entry predictor supports A/B assignment, fail-open, thresholding, and promotion gates', () => {
    const groups = new Set<string>();
    for (let i = 0; i < 200; i++) {
      groups.add(assignABGroup(`signal-${i}`));
    }
    assert.ok(groups.has('control'));
    assert.ok(groups.has('treatment'));

    assert.deepStrictEqual(evaluateEntryFilter('control', new Float32Array([1]), null), {
      allowed: true,
      mlScore: null,
      abGroup: 'control',
      reason: 'control group — no ML filter',
    });

    assert.strictEqual(evaluateEntryFilter('signal-100', new Float32Array([1]), null).allowed, true);
    assert.strictEqual(evaluateEntryFilter('signal-100', new Float32Array([1]), 0.6).allowed, true);
    assert.strictEqual(evaluateEntryFilter('signal-100', new Float32Array([1]), 0.5).allowed, false);

    assert.deepStrictEqual(evaluatePromotionGate(1, 1.2, 499), {
      promote: false,
      reason: 'insufficient trades: 499/500',
    });
    assert.strictEqual(evaluatePromotionGate(1, 1.2, 500).promote, true);
    assert.strictEqual(evaluatePromotionGate(1, 1.05, 500).promote, false);
  });

  test('ensemble scorer combines ML, Gemma, regime, and sentiment signals', () => {
    const strong = scoreEnsemble({
      mlPrediction: {
        probability: 0.7,
        direction: 'buy',
        topFeatures: [['rsi', 0.2]],
        modelPath: 'model.onnx',
        regime: 'strongbull',
        fallback: false,
      },
      gemmaAdjustment: 0.1,
      regimeConfidence: 80,
      regimeName: 'strongbull',
      cachedSentiment: 0.5,
    });

    assert.strictEqual(strong.direction, 'buy');
    assert.strictEqual(strong.shouldTrade, true);
    assert.ok(strong.finalScore > 0.7);
    assert.ok(strong.reasoning.includes('Regime(strongbull)'));

    const fallback = scoreEnsemble({
      mlPrediction: {
        probability: 0.5,
        direction: 'buy',
        topFeatures: [],
        modelPath: '',
        regime: 'uncertain',
        fallback: true,
      },
      gemmaAdjustment: 0,
      regimeConfidence: 0,
      regimeName: 'uncertain',
      cachedSentiment: 0,
    });

    assert.strictEqual(fallback.finalScore, 0.5);
    assert.strictEqual(fallback.shouldTrade, false);
    assert.ok(fallback.reasoning.includes('rule-based fallback'));

    process.env.ML_CONFIDENCE_THRESHOLD = '0.58';
    const nearThreshold = scoreEnsemble({
      mlPrediction: {
        probability: 0.56,
        direction: 'buy',
        topFeatures: [],
        modelPath: 'model.onnx',
        regime: 'sideways',
        fallback: false,
      },
      gemmaAdjustment: 0,
      regimeConfidence: 0,
      regimeName: 'sideways',
      cachedSentiment: 0,
    });
    assert.strictEqual(nearThreshold.shouldTrade, false);
  });

  test('ML health and prediction paths degrade safely when disabled', async () => {
    delete process.env.ML_ENABLED;
    const health = await getMLHealth();
    assert.deepStrictEqual(health, {
      enabled: false,
      modelsReady: false,
      gemmaCache: false,
      modelCount: 0,
    });

    const prediction = await getPrediction([{ time: Date.now(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }], 'BTC/USDT', 'strongbull');
    assert.deepStrictEqual(prediction, {
      probability: 0.5,
      direction: 'buy',
      topFeatures: [],
      modelPath: '',
      regime: 'strongbull',
      fallback: true,
    });
  });
});
