import { RegimeType } from '../regime/detector.js';

export interface Signal {
  symbol: string;
  side: 'buy' | 'sell';
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string;
  indicators: string[]; // List of indicators that triggered the signal
  aiWarning?: boolean; // Flag for non-critical AI errors
}

export class SignalGenerator {
  static aiEnabled = true;
  static aiHealth: {
    totalRequests: number;
    successfulConfirmations: number;
    failedConfirmations: number;
    lastFailureReason: string | null;
    circuitBreakerTripped: boolean;
    consecutiveFailures: number;
  } = {
    totalRequests: 0,
    successfulConfirmations: 0,
    failedConfirmations: 0,
    lastFailureReason: null,
    circuitBreakerTripped: false,
    consecutiveFailures: 0
  };

  private streamingBuffers: Map<string, any[]> = new Map();
  private maxBufferSize = 100;

  // ATR multipliers for different regimes (conservative to aggressive)
  private static ATR_STOP_MULTIPLIERS = {
    ultra_conservative: 2.0,
    conservative: 1.8,
    moderate: 1.5,
    aggressive: 1.2,
    degen: 1.0,
    ai_enhanced: 1.5
  };

  private static ATR_PROFIT_MULTIPLIERS = {
    ultra_conservative: 1.0,
    conservative: 1.2,
    moderate: 1.5,
    aggressive: 2.0,
    degen: 2.5,
    ai_enhanced: 1.5
  };

  static resetAIHealth() {
    this.aiHealth = {
      totalRequests: 0,
      successfulConfirmations: 0,
      failedConfirmations: 0,
      lastFailureReason: null,
      circuitBreakerTripped: false,
      consecutiveFailures: 0
    };
  }

  static getAIHealth() {
    const h = this.aiHealth;
    const successRate = h.totalRequests > 0 ? (h.successfulConfirmations / h.totalRequests) * 100 : 0;
    return {
      ...h,
      successRate,
      aiAvailable: this.aiEnabled && !this.aiHealth.circuitBreakerTripped
    };
  }

  private calculateATRAdjustedLevels(entryPrice: number, atr: number, side: 'buy' | 'sell', riskMode: string): { stopLoss: number, takeProfit: number } {
    const stopMultiplier = SignalGenerator.ATR_STOP_MULTIPLIERS[riskMode] || 1.5;
    const profitMultiplier = SignalGenerator.ATR_PROFIT_MULTIPLIERS[riskMode] || 1.5;

    if (side === 'buy') {
      const stopLoss = entryPrice - (stopMultiplier * atr);
      const takeProfit = entryPrice + (profitMultiplier * atr);
      return { stopLoss, takeProfit };
    } else {
      const stopLoss = entryPrice + (stopMultiplier * atr);
      const takeProfit = entryPrice - (profitMultiplier * atr);
      return { stopLoss, takeProfit };
    }
  }

  // Streaming signal generation
  addToStream(symbol: string, candle: any): void {
    let buffer = this.streamingBuffers.get(symbol);
    if (!buffer) {
      buffer = [];
      this.streamingBuffers.set(symbol, buffer);
    }

    buffer.push(candle);

    // Keep buffer size manageable
    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }
  }

  async generateStreamingSignal(
    symbol: string,
    regime: RegimeType,
    useAI: boolean = false,
    strategy: string = 'regime',
    riskMode: string = 'moderate'
  ): Promise<Signal | null> {
    const buffer = this.streamingBuffers.get(symbol);
    if (!buffer || buffer.length < 50) {
      return null; // Need minimum data for indicators
    }

    // Use the most recent data
    return this.generateSignal(buffer, regime, symbol, useAI, strategy, riskMode);
  }

  getStreamingBufferSize(symbol: string): number {
    const buffer = this.streamingBuffers.get(symbol);
    return buffer ? buffer.length : 0;
  }

  clearStreamingBuffer(symbol: string): void {
    this.streamingBuffers.delete(symbol);
  }

  async generateSignal(df: any[], regime: RegimeType, symbol: string, useAI: boolean = false, strategy: string = 'regime', riskMode: string = 'moderate'): Promise<Signal | null> {
    if (df.length < 50) return null;

    let signal: Signal | null = null;
    
    if (strategy === 'shotgun') {
      signal = this._shotgunStrategy(df, symbol, riskMode);
    } else if (strategy === 'alt_chaser') {
      signal = this._altChaserStrategy(df, symbol, riskMode);
    } else if (strategy === 'chasing_dragons') {
      signal = this._chasingDragonsStrategy(df, symbol, riskMode);
    } else {
      switch (regime) {
        case RegimeType.STRONG_BULL:
          signal = this._strongBullStrategy(df, symbol, riskMode);
          break;
        case RegimeType.WEAK_BULL:
          signal = this._weakBullStrategy(df, symbol, riskMode);
          break;
        case RegimeType.BEAR:
          signal = this._bearStrategy(df, symbol, riskMode);
          break;
        case RegimeType.SIDEWAYS:
          signal = this._sidewaysStrategy(df, symbol, riskMode);
          break;
        default:
          return null;
      }
    }

    if (signal && useAI && SignalGenerator.aiEnabled && !SignalGenerator.aiHealth.circuitBreakerTripped) {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          console.warn("AI Signal Confirmation skipped: GEMINI_API_KEY is not set.");
          SignalGenerator.aiHealth.totalRequests++;
          SignalGenerator.aiHealth.failedConfirmations++;
          SignalGenerator.aiHealth.consecutiveFailures++;
          SignalGenerator.aiHealth.lastFailureReason = 'GEMINI_API_KEY not configured';
          signal.aiWarning = true;
          // Disable AI features when no key is configured
          SignalGenerator.aiEnabled = false;
          if (SignalGenerator.aiHealth.consecutiveFailures >= 3) {
            SignalGenerator.aiHealth.circuitBreakerTripped = true;
            console.error('[AI Circuit Breaker] Tripped due to missing API key');
          }
        } else {
          const { default: OpenAI } = await import('openai');
          const openai = new OpenAI({
            baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
            apiKey: 'ollama'
          });
          
          const lastCandles = df.slice(-5).map(c => ({
            time: new Date(c.time).toISOString(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume
          }));

          const prompt = `You are a quantitative trading system. A base algorithm has generated a ${signal.side.toUpperCase()} signal for ${symbol} based on ${signal.indicators.join(', ')}.
          Entry: ${signal.entryPrice}, Stop Loss: ${signal.stopLoss}, Take Profit: ${signal.takeProfit}.
          Recent price action: ${JSON.stringify(lastCandles)}
          
          Do you confirm this trade? If the macro structure looks poor, reject it.
          Return a JSON object:
          { "confirmed": boolean, "reasoning": "string" }`;

          const response = await openai.chat.completions.create({
            model: process.env.OLLAMA_MODEL || "llama3",
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }]
          });

          const text = response.choices[0].message.content;
          if (text) {
            const aiResult = JSON.parse(text);
            SignalGenerator.aiHealth.totalRequests++;
            SignalGenerator.aiHealth.successfulConfirmations++;
            SignalGenerator.aiHealth.consecutiveFailures = 0;
            if (!aiResult.confirmed) {
              console.log(`AI rejected signal for ${symbol}: ${aiResult.reasoning}`);
              return null; // Block trade when AI rejects
            } else {
              signal.reasoning = `AI Confirmed: ${aiResult.reasoning}`;
            }
          }
        }
      } catch (e: any) {
        SignalGenerator.aiHealth.totalRequests++;
        SignalGenerator.aiHealth.failedConfirmations++;
        SignalGenerator.aiHealth.consecutiveFailures++;
        SignalGenerator.aiHealth.lastFailureReason = e.message || String(e);
        
        if (e.message && e.message.includes("API_KEY_INVALID")) {
          console.error("AI Signal Confirmation failed: Invalid API Key. Disabling AI features.");
          SignalGenerator.aiEnabled = false;
          SignalGenerator.aiHealth.circuitBreakerTripped = true;
          return null; // Block trade when AI key is invalid and AI is required
        } else {
          console.error("AI Signal Confirmation failed:", e);
          // Non-critical AI error: add warning flag to signal, allow trade to proceed
          signal.aiWarning = true;
          signal.reasoning += ` [AI Confirmation Failed: ${e.message}]`;
          
          // Circuit breaker: trip after 5 consecutive failures
          if (SignalGenerator.aiHealth.consecutiveFailures >= 5) {
            SignalGenerator.aiHealth.circuitBreakerTripped = true;
            console.error(`[AI Circuit Breaker] Tripped after ${SignalGenerator.aiHealth.consecutiveFailures} consecutive failures. AI features disabled temporarily.`);
            SignalGenerator.aiEnabled = false;
          }
        }
      }
    }

    return signal;
  }

  _strongBullStrategy(df: any[], symbol: string, riskMode: string): Signal | null {
    const data = df[df.length - 1];
    let score = 0;
    const indicators: string[] = [];

    // Trend confirmation (45%)
    if (data.close > data.ema_9 && data.ema_9 > data.ema_21) {
      score += 45;
      indicators.push('EMA Trend');
    } else {
      return null; // Trend must be intact
    }

    // RSI Momentum (20%)
    if (data.rsi_14 > 50 && data.rsi_14 < 75) {
      score += 20;
      indicators.push('RSI Momentum');
    } else if (data.rsi_14 >= 75) {
      score += 5;
      indicators.push('RSI Overbought');
    }

    // Volume Confirmation (20%)
    if (data.volume_ratio > 1.2) {
      score += 20;
      indicators.push('Volume Surge');
    }

    // Timing: Stoch RSI (15%)
    if (data.stoch_rsi_k < 30) {
      score += 15;
      indicators.push('StochRSI Oversold');
    } else if (data.stoch_rsi_k < 50) {
      score += 5;
      indicators.push('StochRSI Moderate');
    }

    if (score >= 60) {
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(data.close, data.atr, 'buy', riskMode);
      return {
        symbol,
        side: 'buy',
        confidence: score,
        entryPrice: data.close,
        stopLoss,
        takeProfit,
        reasoning: `Strong Bull: Score ${score} - ${indicators.join(', ')} (ATR-adjusted)`,
        indicators
      };
    }
    return null;
  }

  _weakBullStrategy(df: any[], symbol: string, riskMode: string): Signal | null {
    const data = df[df.length - 1];
    let score = 0;
    const indicators: string[] = [];

    // Strategy A: Mean reversion (60% weight)
    if (data.close <= data.bb_lower * 1.01) {
      if (data.close > data.vwap * 0.995) {
        if (data.rsi_14 < 40) {
          score += 60;
          indicators.push('Mean Reversion (BB/VWAP/RSI)');
        }
      }
    }
    // Strategy B: Momentum continuation (40% weight)
    else if (data.close > data.ema_9 && data.ema_9 > data.ema_21) {
      if (data.rsi_14 > 50 && data.rsi_14 < 70) {
        if (data.volume_ratio > 1.3) {
          score += 40;
          indicators.push('Momentum Breakout');
        }
      }
    }

    // Volume confirmation boost
    if (data.close > data.open && data.volume_ratio > 1.1) {
      score += 15;
      indicators.push('Bullish Volume');
    }

    // Penalty: Wrong side of VWAP
    if (data.close < data.vwap * 0.98) {
      score *= 0.7;
    }

    if (score >= 50) {
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(data.close, data.atr, 'buy', riskMode);
      return {
        symbol,
        side: 'buy',
        confidence: Math.min(score, 100),
        entryPrice: data.close,
        stopLoss,
        takeProfit,
        reasoning: `Weak Bull: Score ${Math.min(score, 100).toFixed(0)} - ${indicators.join(', ')} (ATR-adjusted)`,
        indicators
      };
    }
    return null;
  }

  _bearStrategy(df: any[], symbol: string, riskMode: string): Signal | null {
    const data = df[df.length - 1];
    let score = 0;
    const indicators: string[] = [];

    // Must have: Downtrend confirmed
    if (data.ema_9 < data.ema_21) {
      score += 30;
      indicators.push('Downtrend EMA');
    } else {
      return null;
    }

    // Resistance rejection
    if (data.high >= data.bb_upper * 0.995) {
      if (data.close < data.open) {
        if (data.rsi_14 > 60) {
          score += 50;
          indicators.push('Resistance Rejection');
        }
      }
    } else if (data.rsi_14 > 65 && data.rsi_14 < 75) {
      score += 35;
      indicators.push('Failed Rally');
    }

    // MACD confirmation
    if (data.macd_line < data.signal_line) {
      score += 15;
      indicators.push('MACD Bearish');
    }

    if (score >= 50) {
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(data.close, data.atr, 'sell', riskMode);
      return {
        symbol,
        side: 'sell',
        confidence: score,
        entryPrice: data.close,
        stopLoss,
        takeProfit,
        reasoning: `Bear: Score ${score} - ${indicators.join(', ')} (ATR-adjusted)`,
        indicators
      };
    }
    return null;
  }

  _sidewaysStrategy(df: any[], symbol: string, riskMode: string): Signal | null {
    const data = df[df.length - 1];
    let score = 0;
    let side: 'buy' | 'sell' = 'buy';
    const indicators: string[] = [];

    // Long Setup
    if (data.close <= data.bb_lower * 1.005) {
      score += 30;
      indicators.push('BB Lower');
      if (data.rsi_14 < 35) {
        score += 25;
        indicators.push('RSI Oversold');
      }
      if (data.stoch_rsi_k < 25) {
        score += 20;
        indicators.push('Stoch Oversold');
      }
      side = 'buy';
    }
    // Short Setup
    else if (data.close >= data.bb_upper * 0.995) {
      score += 30;
      indicators.push('BB Upper');
      if (data.rsi_14 > 65) {
        score += 25;
        indicators.push('RSI Overbought');
      }
      if (data.stoch_rsi_k > 75) {
        score += 20;
        indicators.push('Stoch Overbought');
      }
      side = 'sell';
    }

    // Volume filter: Reduce if volume spiking
    if (data.volume_ratio > 1.5) {
      score *= 0.5;
      indicators.push('Volume Spike Penalty');
    }

    if (score >= 50) {
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(data.close, data.atr, side, riskMode);
      return {
        symbol,
        side,
        confidence: score,
        entryPrice: data.close,
        stopLoss,
        takeProfit,
        reasoning: `Sideways: Score ${score} - ${indicators.join(', ')} (ATR-adjusted)`,
        indicators
      };
    }

    return null;
  }

  _shotgunStrategy(df: any[], symbol: string, riskMode: string): Signal | null {
    // Shotgun: Buy/sell 0.5s before candle end, close 10s after.
    // This needs to be triggered at specific times.
    // For now, let's just return a signal if indicators align.
    const last = df[df.length - 1];
    if (last.rsi_14 > 50) {
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(last.close, last.atr, 'buy', riskMode);
      return {
        symbol,
        side: 'buy',
        confidence: 60,
        entryPrice: last.close,
        stopLoss,
        takeProfit,
        reasoning: 'Shotgun: Triggered by RSI (ATR-adjusted)',
        indicators: ['RSI']
      };
    }
    return null;
  }

  _altChaserStrategy(df: any[], symbol: string, riskMode: string): Signal | null {
    const last = df[df.length - 1];
    const prev = df[df.length - 2];
    const change = Math.abs(last.close - prev.close) / prev.close;
    if (change > 0.01) {
      const side = last.close > prev.close ? 'buy' : 'sell';
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(last.close, last.atr, side, riskMode);
      return {
        symbol,
        side,
        confidence: 65,
        entryPrice: last.close,
        stopLoss,
        takeProfit,
        reasoning: 'Alt Chaser: Price change > 1% (ATR-adjusted)',
        indicators: ['Price Action']
      };
    }
    return null;
  }

  _chasingDragonsStrategy(df: any[], symbol: string, riskMode: string): Signal | null {
    const last = df[df.length - 1];
    // Placeholder for probability score logic
    if (last.rsi_14 > 50) {
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(last.close, last.atr, 'buy', riskMode);
      return {
        symbol,
        side: 'buy',
        confidence: 75,
        entryPrice: last.close,
        stopLoss,
        takeProfit,
        reasoning: 'Chasing Dragons: Probability score maintained (ATR-adjusted)',
        indicators: ['RSI']
      };
    }
    return null;
  }
}
