export enum RegimeType {
  STRONG_BULL = "strong_bull",
  WEAK_BULL = "weak_bull",
  BEAR = "bear",
  SIDEWAYS = "sideways",
  UNCERTAIN = "uncertain"
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

    let aiValidation = null;

    if (useAI && RegimeDetector.aiEnabled) {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          console.warn("AI Regime Analysis skipped: GEMINI_API_KEY is not set.");
        } else {
          const { GoogleGenAI } = await import('@google/genai');
          const ai = new GoogleGenAI({ apiKey });
          
          // Use provided market context or default to mock
          const context = marketContext || {
            btc_dominance: "52%",
            fear_greed_index: 45,
            major_news: "Market awaiting key economic data",
            all_news: ["Market awaiting key economic data"]
          };

          const prompt = `You are analyzing trading system performance and news sentiment for regime validation.
Current regime detected by rule-based algorithm: ${regime}
Rule-based confidence: ${confidence}%

Technical Metrics: ${JSON.stringify(metrics)}
Shadow Performance (7d): ${JSON.stringify(shadowPerformance)}
Market Context (News & Global): ${JSON.stringify(context)}

Tasks:
1. Validate if regime classification is correct based on technicals AND news sentiment.
2. Analyze the sentiment of the provided news (all_news). Are they bullish, bearish, or neutral?
3. Identify if external factors (news, macro) explain recent shadow performance.
4. Recommend: [continue | reduce_risk | halt | switch]

Output JSON only:
{
  "regime_validation": "correct" | "misclassified",
  "news_sentiment": "bullish" | "bearish" | "neutral",
  "sentiment_score": number (-1.0 to 1.0),
  "performance_explanation": "string (1 sentence)",
  "external_factors": ["string"],
  "recommended_action": "continue" | "reduce_risk" | "halt" | "switch",
  "confidence": number (0-100)
}`;

          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
            config: {
              responseMimeType: "application/json"
            }
          });

          if (response.text) {
            aiValidation = JSON.parse(response.text);
            reasoning = `AI Analysis: ${aiValidation.performance_explanation} Sentiment: ${aiValidation.news_sentiment} (${aiValidation.sentiment_score}). Rec: ${aiValidation.recommended_action}.`;

            // Adjust confidence based on sentiment alignment
            if (aiValidation.news_sentiment === 'bullish' && (regime === RegimeType.STRONG_BULL || regime === RegimeType.WEAK_BULL)) {
              confidence = Math.min(100, confidence + 5);
            } else if (aiValidation.news_sentiment === 'bearish' && regime === RegimeType.BEAR) {
              confidence = Math.min(100, confidence + 5);
            } else if (aiValidation.news_sentiment !== 'neutral') {
              // Dissonance between technicals and news
              confidence = Math.max(50, confidence - 10);
            }
          }
        }
      } catch (e: any) {
        if (e.message && e.message.includes("API_KEY_INVALID")) {
          console.error("AI Regime Analysis failed: Invalid API Key. Disabling AI features.");
          RegimeDetector.aiEnabled = false;
        } else {
          console.error("AI Regime Analysis failed:", e);
        }
      }
    }

    return {
      regime,
      confidence,
      metrics,
      reasoning,
      aiValidation,
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

    // console.log(`[RegimeDetector] Classifying: adx=${adx}, price30d=${price_change_30d}, price7d=${price_change_7d}, vol=${volume_ratio}`);

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
