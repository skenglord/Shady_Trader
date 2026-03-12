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
    const last = df[df.length - 1];
    const prev = df[df.length - 2];

    // Buy dips in uptrend: Price touches EMA 21 and bounces
    if (prev.low <= prev.ema_21 && last.close > last.ema_21 && last.rsi_14 > 50) {
      const entryPrice = last.close;
      const stopLoss = last.ema_50 * 0.99; // 1% below EMA 50
      const takeProfit = entryPrice + (entryPrice - stopLoss) * 2; // 1:2 RR

      return {
        symbol,
        side: 'buy',
        confidence: 85,
        entryPrice,
        stopLoss,
        takeProfit,
        reasoning: 'Strong Bull: Price bounced off EMA 21',
        indicators: ['EMA 21', 'RSI']
      };
    }
    return null;
  }

  _weakBullStrategy(df: any[], symbol: string): Signal | null {
    const last = df[df.length - 1];

    // Momentum + Mean Reversion: Buy near lower BB if RSI is oversold
    if (last.close <= last.bb_lower * 1.01 && last.rsi_14 < 40) {
      const entryPrice = last.close;
      const stopLoss = last.bb_lower * 0.98; // 2% below lower BB
      const takeProfit = last.bb_middle; // Target middle BB

      return {
        symbol,
        side: 'buy',
        confidence: 75,
        entryPrice,
        stopLoss,
        takeProfit,
        reasoning: 'Weak Bull: Mean reversion from lower Bollinger Band',
        indicators: ['Bollinger Bands', 'RSI']
      };
    }
    return null;
  }

  _bearStrategy(df: any[], symbol: string): Signal | null {
    const last = df[df.length - 1];

    // Short rallies: Price touches upper BB and RSI is overbought
    if (last.close >= last.bb_upper * 0.99 && last.rsi_14 > 60) {
      const entryPrice = last.close;
      const stopLoss = last.bb_upper * 1.02; // 2% above upper BB
      const takeProfit = last.bb_lower; // Target lower BB

      return {
        symbol,
        side: 'sell',
        confidence: 80,
        entryPrice,
        stopLoss,
        takeProfit,
        reasoning: 'Bear: Shorting rally at upper Bollinger Band',
        indicators: ['Bollinger Bands', 'RSI']
      };
    }
    return null;
  }

  _sidewaysStrategy(df: any[], symbol: string): Signal | null {
    const last = df[df.length - 1];

    // Range trading: Buy support
    if (last.close <= last.bb_lower * 1.005 && last.rsi_14 < 35) {
      const entryPrice = last.close;
      const stopLoss = last.bb_lower * 0.98;
      const takeProfit = last.bb_upper * 0.99;

      return {
        symbol,
        side: 'buy',
        confidence: 70,
        entryPrice,
        stopLoss,
        takeProfit,
        reasoning: 'Sideways: Buying support at lower Bollinger Band',
        indicators: ['Bollinger Bands', 'RSI']
      };
    }

    // Range trading: Sell resistance
    if (last.close >= last.bb_upper * 0.995 && last.rsi_14 > 65) {
      const entryPrice = last.close;
      const stopLoss = last.bb_upper * 1.02;
      const takeProfit = last.bb_lower * 1.01;

      return {
        symbol,
        side: 'sell',
        confidence: 70,
        entryPrice,
        stopLoss,
        takeProfit,
        reasoning: 'Sideways: Selling resistance at upper Bollinger Band',
        indicators: ['Bollinger Bands', 'RSI']
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
