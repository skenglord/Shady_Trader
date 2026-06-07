import type {
  CompositeRegime, TrendDirection, TrendStrength, VolatilityRegime
} from '../types/regime.js';
import { logger } from '../logging/logger.js';

export enum RegimeType {
  STRONG_BULL = "strongbull",
  WEAK_BULL = "weakbull",
  BEAR = "bear",
  SIDEWAYS = "sideways",
  UNCERTAIN = "uncertain"
}

// ── v6.0 Regime Detector v2: three-axis composite ──

export function getTrendDirection(df: any): TrendDirection {
  const ema9 = df.ema_9 ?? df.ema9 ?? df.close;
  const ema21 = df.ema_21 ?? df.ema21 ?? df.close;
  const ema50 = df.ema_50 ?? df.ema50 ?? df.close;
  const slope = ema50 > 0 ? (df.close - ema50) / ema50 : 0;
  if (df.close > ema9 && ema9 > ema21 && ema21 > ema50 && slope > 0.002) return 'up';
  if (df.close < ema9 && ema9 < ema21 && ema21 < ema50 && slope < -0.002) return 'down';
  return 'flat';
}

export function getTrendStrength(adx14: number): TrendStrength {
  if (adx14 >= 28) return 'strong';
  if (adx14 >= 18) return 'moderate';
  return 'weak';
}

export interface AtrPercentileResult {
  percentile: number;  // 0..1
  usable:     boolean; // false until bootstrap window is filled
}

/**
 * Compute ATR percentile rank within a rolling history.
 * * Bug Fix 2: lookback default raised to 8064 candles (4 weeks at 5m);
 * bootstrap minimum 288 (1 day) before percentile is trusted.
 */
export function computeAtrPercentile(
  history: number[],
  current: number,
  bootstrapMin: number = parseInt(process.env.ATR_PERCENTILE_BOOTSTRAP_MIN ?? '288')
): AtrPercentileResult {
  const valid = history.filter(v => isFinite(v) && v > 0);
  if (valid.length < 20) return { percentile: 0.5, usable: false };
  const below = valid.filter(v => v <= current).length;
  return { percentile: below / valid.length, usable: valid.length >= bootstrapMin };
}

export function getVolatilityRegime(r: AtrPercentileResult): VolatilityRegime {
  if (!r.usable) return 'normal';
  if (r.percentile < 0.30) return 'low';
  if (r.percentile < 0.70) return 'normal';
  return 'high';
}

/**
 * Map three axes to a composite regime.
 * * Bug Fix 3: ALL downtrends map to 'bear' unconditionally (no fall-through to sideways).
 */
export function getCompositeRegime(
  dir: TrendDirection,
  str: TrendStrength,
  vol: VolatilityRegime
): CompositeRegime {
  if (dir === 'down') return 'bear';                // ALL downtrends = bear, no exceptions
  if (dir === 'up' && str === 'strong') return 'strongbull';
  if (dir === 'up' && str === 'moderate') return 'weakbull';
  if (dir === 'up' && str === 'weak') return 'sideways';
  if (vol === 'high') return 'uncertain';
  return 'sideways';
}

/** Stability = fraction of recent N regime reads matching current. Monitoring-only by default. */
export function computeRegimeStability(
  history: CompositeRegime[],
  current: CompositeRegime,
  window: number = 12
): number {
  const tail = history.slice(-window);
  if (!tail.length) return 1.0;
  return tail.filter(r => r === current).length / tail.length;
}

export class RegimeDetector {
  static aiEnabled = true;

  STRONG_BULL_THRESHOLDS = {
    adx_min: 30,
    price_30d_min: 0.12,
    price_7d_min: 0.03,
    volume_ratio_min: 1.3
  };

  BEAR_THRESHOLDS = {
    price_30d_max: -0.08,
    price_7d_max: -0.05,
    rsi_avg_max: 40
  };

  SIDEWAYS_THRESHOLDS = {
    adx_max: 20,
    price_30d_range: 0.04,
    price_7d_range: 0.015
  };

  WEAK_BULL_THRESHOLDS = {
    price_30d_min: 0.04,
    price_30d_max: 0.12
  };

  async detect(df: any[], useAI: boolean = false, shadowPerformance: any = null, marketContext: any = null) {
    const metrics = this._calculateMetrics(df);
    let { regime, confidence, reasoning } = this._classifyRegime(metrics);
    ({ regime, confidence, reasoning } = this._applyNewsSentimentWeight(regime, confidence, reasoning, marketContext));

    // ── v6.0 three-axis composite (additive; does not alter legacy `regime`) ──
    const lastRow = df[df.length - 1] || {};
    const trendDir = getTrendDirection(lastRow);
    const trendStrength = getTrendStrength(lastRow.adx ?? lastRow.adx14 ?? 0);
    const atrHistory = df.map((r: any) => r.atr ?? r.atr_14 ?? 0).filter((v: number) => v > 0);
    const atrResult = computeAtrPercentile(atrHistory, lastRow.atr ?? lastRow.atr_14 ?? 0);
    const volRegime = getVolatilityRegime(atrResult);
    const composite = getCompositeRegime(trendDir, trendStrength, volRegime);

    let aiValidation = null;

    if (useAI && RegimeDetector.aiEnabled) {
      try {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({
          baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
          apiKey: 'ollama', // required but ignored by ollama
        });
        
        // Use provided market context or default to mock
        const context = marketContext || {
          major_news: "Market awaiting key economic data",
        };

        const prompt = `Market regime: ${regime}
Technical metrics: ${JSON.stringify(metrics)}
7d shadow performance: ${JSON.stringify(shadowPerformance)}
Recent news context: ${JSON.stringify(context)}

Write one sentence (max 25 words) explaining what the news context suggests 
about whether the ${regime} classification is reliable right now.

Output JSON only:
{
  "narrative": "single sentence explanation",
  "news_sentiment": "bullish" | "bearish" | "neutral"
}`;

        const response = await openai.chat.completions.create({
          model: process.env.OLLAMA_MODEL || "gemma:2b",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
        });

        const text = response.choices[0].message.content;
        if (text) {
          const cleaned = text.replace(/```(?:json)?/g, '').trim();
          const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            aiValidation = JSON.parse(jsonMatch[0]);
            reasoning = `${reasoning} Narrative: ${aiValidation.narrative}`;
          }
        }
      } catch (e: any) {
        logger.error("AI Narrative Generation failed", { error: e.message, service: 'regime-detector' });
        if (e.message && e.message.includes("fetch failed")) {
           RegimeDetector.aiEnabled = false;
        }
      }
    }

    return {
      regime,
      confidence,
      metrics,
      reasoning,
      aiValidation,
      // ── v6.0 three-axis composite fields ──
      composite,
      trendDir,
      trendStrength,
      volRegime,
      atrPercentile: atrResult.percentile,
      atrUsable: atrResult.usable,
      timestamp: df[df.length - 1]?.time || null
    };
  }

  _calculateMetrics(df: any[]) {
    const periods_30d = Math.min(df.length, 2880);
    const periods_7d = Math.min(df.length, 672);

    const price_30d = this._calculatePriceChange(df, periods_30d);
    const price_7d = this._calculatePriceChange(df, periods_7d);

    const lastRow = df[df.length - 1];
    const adx = lastRow.adx;

    const last30d = df.slice(-periods_30d);
    const avg_volume_30d = last30d.reduce((sum, row) => sum + (row.volume || 0), 0) / last30d.length;

    const last7d = df.slice(-periods_7d);
    const avg_volume_7d = last7d.reduce((sum, row) => sum + (row.volume || 0), 0) / last7d.length;

    const volume_ratio = avg_volume_30d > 0 ? avg_volume_7d / avg_volume_30d : 1;

    const rsi_avg_7d = last7d.reduce((sum, row) => sum + (row.rsi_14 || 0), 0) / last7d.length;

    return {
      price_change_30d: price_30d,
      price_change_7d: price_7d,
      adx,
      volume_ratio,
      rsi_avg_7d
    };
  }

  _calculatePriceChange(df: any[], periods: number) {
    if (df.length < periods) periods = df.length;
    if (periods === 0) return 0;

    const current = df[df.length - 1].close;
    const past = df[df.length - periods].close;

    return (current - past) / past;
  }

  _classifyRegime(metrics: any) {
    const { adx, price_change_30d, price_change_7d, volume_ratio, rsi_avg_7d } = metrics;

    // logger.info('Classifying: adx=${adx}, price30d=${price_change_30d}, price7d=${price_change_7d}, vol=${volume_ratio}', { service: 'regimedetector' });

    if (
      adx > this.STRONG_BULL_THRESHOLDS.adx_min &&
      price_change_30d > this.STRONG_BULL_THRESHOLDS.price_30d_min &&
      price_change_7d >= this.STRONG_BULL_THRESHOLDS.price_7d_min &&
      volume_ratio >= this.STRONG_BULL_THRESHOLDS.volume_ratio_min
    ) {
      return {
        regime: RegimeType.STRONG_BULL,
        confidence: 95,
        reasoning: `Strong uptrend: ADX ${adx.toFixed(1)}, +${(price_change_30d * 100).toFixed(1)}% (30d), volume ${volume_ratio.toFixed(1)}x average`
      };
    }

    if (
      price_change_30d < this.BEAR_THRESHOLDS.price_30d_max ||
      (price_change_7d < this.BEAR_THRESHOLDS.price_7d_max && rsi_avg_7d < this.BEAR_THRESHOLDS.rsi_avg_max)
    ) {
      return {
        regime: RegimeType.BEAR,
        confidence: 85,
        reasoning: `Downtrend detected: ${(price_change_30d * 100).toFixed(1)}% (30d), RSI avg ${rsi_avg_7d.toFixed(1)}`
      };
    }

    if (
      adx < this.SIDEWAYS_THRESHOLDS.adx_max &&
      Math.abs(price_change_30d) < this.SIDEWAYS_THRESHOLDS.price_30d_range &&
      Math.abs(price_change_7d) < this.SIDEWAYS_THRESHOLDS.price_7d_range
    ) {
      return {
        regime: RegimeType.SIDEWAYS,
        confidence: 80,
        reasoning: `Range-bound: ADX ${adx.toFixed(1)}, price ±${(Math.abs(price_change_30d) * 100).toFixed(1)}% (30d)`
      };
    }

    if (
      price_change_30d > this.WEAK_BULL_THRESHOLDS.price_30d_min &&
      price_change_30d < this.WEAK_BULL_THRESHOLDS.price_30d_max
    ) {
      return {
        regime: RegimeType.WEAK_BULL,
        confidence: 70,
        reasoning: `Weak uptrend: +${(price_change_30d * 100).toFixed(1)}% (30d), ADX ${adx.toFixed(1)}`
      };
    }

    return {
      regime: RegimeType.UNCERTAIN,
      confidence: 50,
      reasoning: "Market regime unclear, awaiting confirmation"
    };
  }

  _applyNewsSentimentWeight(regime: RegimeType, confidence: number, reasoning: string, marketContext: any) {
    if (!marketContext) return { regime, confidence, reasoning };

    const sentimentLabel = String(marketContext.news_sentiment || '').toLowerCase();
    const rawScore = Number(marketContext.sentiment_score ?? Number.NaN);
    const score = Number.isFinite(rawScore)
      ? Math.max(-1, Math.min(1, rawScore))
      : sentimentLabel === 'bullish'
        ? 0.5
        : sentimentLabel === 'bearish'
          ? -0.5
          : 0;
    if (score === 0) return { regime, confidence, reasoning };

    const isBullRegime = regime === RegimeType.STRONG_BULL || regime === RegimeType.WEAK_BULL;
    const aligns = (score > 0 && isBullRegime) || (score < 0 && regime === RegimeType.BEAR);
    const magnitudeBoost = Math.max(2, Math.round(Math.abs(score) * 10));

    if (aligns) {
      const boostedConfidence = Math.min(100, confidence + magnitudeBoost);
      return {
        regime,
        confidence: boostedConfidence,
        reasoning: `${reasoning}. News sentiment alignment score=${score.toFixed(2)} boosted confidence by ${boostedConfidence - confidence}.`
      };
    }

    if (regime === RegimeType.UNCERTAIN && Math.abs(score) >= 0.75) {
      const sentimentRegime = score > 0 ? RegimeType.WEAK_BULL : RegimeType.BEAR;
      const sentimentConfidence = Math.max(confidence, 60 + Math.round(Math.abs(score) * 10));
      return {
        regime: sentimentRegime,
        confidence: Math.min(85, sentimentConfidence),
        reasoning: `${reasoning}. Strong news sentiment score=${score.toFixed(2)} nudged regime to ${sentimentRegime}.`
      };
    }

    const reducedConfidence = Math.max(45, confidence - Math.max(4, magnitudeBoost));
    return {
      regime,
      confidence: reducedConfidence,
      reasoning: `${reasoning}. News sentiment dissonance score=${score.toFixed(2)} reduced confidence by ${confidence - reducedConfidence}.`
    };
  }

  shouldUpdateRegime(lastRegime: RegimeType, newRegime: RegimeType, newConfidence: number) {
    if (lastRegime !== newRegime && newConfidence > 75) return true;
    if (lastRegime === RegimeType.UNCERTAIN && newConfidence > 70) return true;
    return false;
  }
}
