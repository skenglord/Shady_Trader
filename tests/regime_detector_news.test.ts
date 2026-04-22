import { describe, test } from 'node:test';
import assert from 'node:assert';
import { RegimeDetector, RegimeType } from '../backend/regime/detector.js';

describe('RegimeDetector news-sentiment weighting', () => {
  test('boosts confidence when bullish sentiment aligns with bull regime', () => {
    const detector = new RegimeDetector();
    const weighted = detector._applyNewsSentimentWeight(
      RegimeType.WEAK_BULL,
      70,
      'Weak trend',
      { sentiment_score: 0.9, news_sentiment: 'bullish' }
    );

    assert.strictEqual(weighted.regime, RegimeType.WEAK_BULL);
    assert.ok(weighted.confidence > 70);
  });

  test('reduces confidence when sentiment conflicts with regime', () => {
    const detector = new RegimeDetector();
    const weighted = detector._applyNewsSentimentWeight(
      RegimeType.STRONG_BULL,
      95,
      'Strong uptrend',
      { sentiment_score: -0.7, news_sentiment: 'bearish' }
    );

    assert.strictEqual(weighted.regime, RegimeType.STRONG_BULL);
    assert.ok(weighted.confidence < 95);
  });

  test('nudges uncertain regimes when sentiment is strongly directional', () => {
    const detector = new RegimeDetector();
    const bearish = detector._applyNewsSentimentWeight(
      RegimeType.UNCERTAIN,
      50,
      'Unclear regime',
      { sentiment_score: -0.9 }
    );
    assert.strictEqual(bearish.regime, RegimeType.BEAR);
    assert.ok(bearish.confidence >= 60);
  });

  test('detect() returns sentiment-weighted confidence without AI calls', async () => {
    const detector = new RegimeDetector();
    const df = [
      { close: 100, volume: 1000, rsi_14: 55, adx: 31, time: 1 },
      { close: 120, volume: 1800, rsi_14: 62, adx: 35, time: 2 }
    ];

    const plain = await detector.detect(df, false, null, null);
    const weighted = await detector.detect(df, false, null, { sentiment_score: 0.8, news_sentiment: 'bullish' });
    assert.ok(weighted.confidence >= plain.confidence);
  });
});
