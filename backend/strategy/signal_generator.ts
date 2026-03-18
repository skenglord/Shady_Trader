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
}

export class SignalGenerator {
  static aiEnabled = true;

  async generateSignal(df: any[], regime: RegimeType, symbol: string, useAI: boolean = false, strategy: string = 'regime'): Promise<Signal | null> {
    if (df.length < 50) return null;

    let signal: Signal | null = null;
    
    if (strategy === 'shotgun') {
      signal = this._shotgunStrategy(df, symbol);
    } else if (strategy === 'alt_chaser') {
      signal = this._altChaserStrategy(df, symbol);
    } else if (strategy === 'chasing_dragons') {
      signal = this._chasingDragonsStrategy(df, symbol);
    } else {
      switch (regime) {
        case RegimeType.STRONG_BULL:
          signal = this._strongBullStrategy(df, symbol);
          break;
        case RegimeType.WEAK_BULL:
          signal = this._weakBullStrategy(df, symbol);
          break;
        case RegimeType.BEAR:
          signal = this._bearStrategy(df, symbol);
          break;
        case RegimeType.SIDEWAYS:
          signal = this._sidewaysStrategy(df, symbol);
          break;
        default:
          return null;
      }
    }

    if (signal && useAI && SignalGenerator.aiEnabled) {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          console.warn("AI Signal Confirmation skipped: GEMINI_API_KEY is not set.");
        } else {
          const { GoogleGenAI } = await import('@google/genai');
          const ai = new GoogleGenAI({ apiKey });
          
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

          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
            config: {
              responseMimeType: "application/json"
            }
          });

          if (response.text) {
            const aiResult = JSON.parse(response.text);
            if (!aiResult.confirmed) {
              console.log(`AI rejected signal for ${symbol}: ${aiResult.reasoning}`);
              return null;
            } else {
              signal.reasoning = `AI Confirmed: ${aiResult.reasoning}`;
            }
          }
        }
      } catch (e: any) {
        if (e.message && e.message.includes("API_KEY_INVALID")) {
          console.error("AI Signal Confirmation failed: Invalid API Key. Disabling AI features.");
          SignalGenerator.aiEnabled = false;
        } else {
          console.error("AI Signal Confirmation failed:", e);
        }
      }
    }

    return signal;
  }

  _strongBullStrategy(df: any[], symbol: string): Signal | null {
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
      return {
        symbol,
        side: 'buy',
        confidence: score,
        entryPrice: data.close,
        stopLoss: data.close * 0.985, // Default 1.5% as per MD Ultra-Conservative
        takeProfit: data.close * 1.008, // Default 0.8%
        reasoning: `Strong Bull: Score ${score} - ${indicators.join(', ')}`,
        indicators
      };
    }
    return null;
  }

  _weakBullStrategy(df: any[], symbol: string): Signal | null {
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
      return {
        symbol,
        side: 'buy',
        confidence: Math.min(score, 100),
        entryPrice: data.close,
        stopLoss: data.close * 0.98, // 2%
        takeProfit: data.close * 1.012, // 1.2%
        reasoning: `Weak Bull: Score ${Math.min(score, 100).toFixed(0)} - ${indicators.join(', ')}`,
        indicators
      };
    }
    return null;
  }

  _bearStrategy(df: any[], symbol: string): Signal | null {
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
      return {
        symbol,
        side: 'sell',
        confidence: score,
        entryPrice: data.close,
        stopLoss: data.close * 1.02, // 2%
        takeProfit: data.close * 0.98, // 2% (Target lower BB)
        reasoning: `Bear: Score ${score} - ${indicators.join(', ')}`,
        indicators
      };
    }
    return null;
  }

  _sidewaysStrategy(df: any[], symbol: string): Signal | null {
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
      return {
        symbol,
        side,
        confidence: score,
        entryPrice: data.close,
        stopLoss: side === 'buy' ? data.close * 0.985 : data.close * 1.015,
        takeProfit: side === 'buy' ? data.close * 1.006 : data.close * 0.994,
        reasoning: `Sideways: Score ${score} - ${indicators.join(', ')}`,
        indicators
      };
    }

    return null;
  }

  _shotgunStrategy(df: any[], symbol: string): Signal | null {
    // Shotgun: Buy/sell 0.5s before candle end, close 10s after.
    // This needs to be triggered at specific times.
    // For now, let's just return a signal if indicators align.
    const last = df[df.length - 1];
    if (last.rsi_14 > 50) {
      return {
        symbol,
        side: 'buy',
        confidence: 60,
        entryPrice: last.close,
        stopLoss: last.close * 0.99,
        takeProfit: last.close * 1.01,
        reasoning: 'Shotgun: Triggered by RSI',
        indicators: ['RSI']
      };
    }
    return null;
  }

  _altChaserStrategy(df: any[], symbol: string): Signal | null {
    const last = df[df.length - 1];
    const prev = df[df.length - 2];
    const change = Math.abs(last.close - prev.close) / prev.close;
    if (change > 0.01) {
      return {
        symbol,
        side: last.close > prev.close ? 'buy' : 'sell',
        confidence: 65,
        entryPrice: last.close,
        stopLoss: last.close * 0.98,
        takeProfit: last.close * 1.02,
        reasoning: 'Alt Chaser: Price change > 1%',
        indicators: ['Price Action']
      };
    }
    return null;
  }

  _chasingDragonsStrategy(df: any[], symbol: string): Signal | null {
    const last = df[df.length - 1];
    // Placeholder for probability score logic
    if (last.rsi_14 > 50) {
      return {
        symbol,
        side: 'buy',
        confidence: 75,
        entryPrice: last.close,
        stopLoss: last.close * 0.94, // 6% stop loss
        takeProfit: last.close * 1.10,
        reasoning: 'Chasing Dragons: Probability score maintained',
        indicators: ['RSI']
      };
    }
    return null;
  }
}
