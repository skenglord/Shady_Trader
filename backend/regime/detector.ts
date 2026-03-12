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

  async detect(df: any[], useAI: boolean = false) {
    const metrics = this._calculateMetrics(df);
    let { regime, confidence, reasoning } = this._classifyRegime(metrics);

    if (useAI && RegimeDetector.aiEnabled) {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          console.warn("AI Sentiment Analysis skipped: GEMINI_API_KEY is not set.");
        } else {
          const { GoogleGenAI } = await import('@google/genai');
          const ai = new GoogleGenAI({ apiKey });
          
          // Fetch some basic crypto news for sentiment (mocking the fetch for reliability in preview)
          // In a real app, you'd fetch from CryptoPanic or similar
          const recentNews = [
            "Bitcoin shows resilience despite macro headwinds",
            "Institutional adoption of crypto continues to grow",
            "Regulatory clarity improves in major markets"
          ].join('. ');

          const prompt = `You are a quantitative analyst. Based on these technical metrics: ${JSON.stringify(metrics)}
          and the current news sentiment: "${recentNews}",
          The base algorithm classified the regime as ${regime} with ${confidence}% confidence.
          Do you agree? If the sentiment strongly contradicts the technicals, you can adjust the regime or confidence.
          Return a JSON object with:
          { "regime": "strong_bull" | "weak_bull" | "bear" | "sideways" | "uncertain", "confidence": number, "reasoning": "string" }`;

          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
            config: {
              responseMimeType: "application/json"
            }
          });

          if (response.text) {
            const aiResult = JSON.parse(response.text);
            if (aiResult.regime && aiResult.confidence) {
              regime = aiResult.regime;
              confidence = aiResult.confidence;
              reasoning = `AI Adjusted: ${aiResult.reasoning}`;
            }
          }
        }
      } catch (e: any) {
        if (e.message && e.message.includes("API_KEY_INVALID")) {
          console.error("AI Sentiment Analysis failed: Invalid API Key. Disabling AI features.");
          RegimeDetector.aiEnabled = false;
        } else {
          console.error("AI Sentiment Analysis failed:", e);
        }
      }
    }

    return {
      regime,
      confidence,
      metrics,
      reasoning,
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
    const volume_ratio = lastRow.volume_ratio;

    const last7d = df.slice(-periods_7d);
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

    if (
      adx > this.STRONG_BULL_THRESHOLDS.adx_min &&
      price_change_30d > this.STRONG_BULL_THRESHOLDS.price_30d_min &&
      price_change_7d > this.STRONG_BULL_THRESHOLDS.price_7d_min &&
      volume_ratio > this.STRONG_BULL_THRESHOLDS.volume_ratio_min
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

  shouldUpdateRegime(lastRegime: RegimeType, newRegime: RegimeType, newConfidence: number) {
    if (lastRegime !== newRegime && newConfidence > 75) return true;
    if (lastRegime === RegimeType.UNCERTAIN && newConfidence > 70) return true;
    return false;
  }
}
