import { RegimeType } from '../regime/detector.js';
import { logger } from '../logging/logger.js';

// ── v6.0 Block 5: confidence thresholds (recalibrated after StochRSI removal) ──
export const CONF_THRESHOLD = 72;       // was 75
export const CONF_THRESHOLD_HIGH = 82;  // was 85

// ── v6.0 Block 5: universal divergence hard-block ──
// Called at the top of every strategy scoring path before any other logic.
export function checkDivergenceBlock(
  data: any,
  side: 'buy' | 'sell'
): { blocked: boolean; reason: string } {
  if (side === 'buy') {
    if (data.wt_bear_div)  return { blocked: true,
      reason: 'WT bearish divergence — price new high, momentum not confirming' };
    if (data.mfi_bear_div) return { blocked: true,
      reason: 'MFI bearish divergence — distribution detected at highs' };
  }
  if (side === 'sell') {
    if (data.wt_bull_div)  return { blocked: true,
      reason: 'WT bullish divergence — price new low, momentum recovering' };
    if (data.mfi_bull_div) return { blocked: true,
      reason: 'MFI bullish divergence — accumulation at lows' };
  }
  return { blocked: false, reason: '' };
}

export interface Signal {
  symbol: string;
  side: 'buy' | 'sell';
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string;
  indicators: string[];
  aiWarning?: boolean;
  // ML Meta-labeling fields
  mlScore?: number;
  mlDirection?: 'buy' | 'sell';
  mlReasoning?: string;
  mlDisagreement?: boolean;
  topFeatures?: [string, number][];
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
    if (df.length < 20) return null;

    // ── v6.0 Block 5: compute regime-relative RSI once per cycle, attach flags to last row ──
    try {
      const { computeRRRsi } = await import('../indicators/rrRsi.js');
      const { normalizeRegime } = await import('../types/regime.js');
      const rsiHist = df.map((r: any) => r.rsi_14).filter((v: any) => typeof v === 'number');
      const rr = computeRRRsi(rsiHist, normalizeRegime(String(regime)));
      const last = df[df.length - 1];
      last.rr_oversold = rr.flags.oversold;
      last.rr_overbought = rr.flags.overbought;
      last.rr_bullish_momentum = rr.flags.bullishMomentum;
      last.rr_bearish_momentum = rr.flags.bearishMomentum;
    } catch { /* fail open — strategies fall back to legacy RSI checks */ }

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
          signal = this._sidewaysStrategy(df, symbol, riskMode);
          break;
      }
    }

    // ── v6.0 Block 5: universal divergence hard-block ──
    if (signal) {
      const divBlock = checkDivergenceBlock(df[df.length - 1], signal.side);
      if (divBlock.blocked) {
        logger.info('signal_blocked', {
          service: 'SignalGenerator',
          symbol, regime, side: signal.side, reason: divBlock.reason, ts: Date.now()
        });
        return null;
      }
    }

    if (signal && useAI && SignalGenerator.aiEnabled && !SignalGenerator.aiHealth.circuitBreakerTripped) {
      try {
        const mlPrediction = await (async () => {
          const { getPrediction } = await import('../ml/predictor.js');
          const { getCachedAdjustment } = await import('../ml/gemma_adjuster.js');
          const { scoreEnsemble } = await import('../ml/ensemble_scorer.js');

          const regimeName = regime === RegimeType.STRONG_BULL ? 'strongbull'
            : regime === RegimeType.WEAK_BULL ? 'weakbull'
            : regime === RegimeType.BEAR ? 'bear'
            : regime === RegimeType.SIDEWAYS ? 'sideways'
            : 'uncertain';

          const prediction = await getPrediction(df, symbol, regimeName);
          if (prediction.fallback) return null;

          const gemmaAdj = await getCachedAdjustment();
          const ensemble = scoreEnsemble({
            mlPrediction: prediction,
            gemmaAdjustment: gemmaAdj,
            regimeConfidence: 70,
            regimeName,
            cachedSentiment: 0
          });

          return { ensemble, prediction };
        })();

        if (mlPrediction) {
          const { ensemble, prediction } = mlPrediction;
          SignalGenerator.aiHealth.totalRequests++;
          SignalGenerator.aiHealth.successfulConfirmations++;

          if (ensemble.direction !== signal.side) {
            signal.confidence = Math.max(0, signal.confidence - 20);
            signal.mlDisagreement = true;
          } else {
            const boost = Math.round((ensemble.finalScore - 0.5) * 40);
            signal.confidence = Math.min(100, signal.confidence + boost);
          }

          signal.mlScore = ensemble.finalScore;
          signal.mlDirection = ensemble.direction;
          signal.mlReasoning = ensemble.reasoning;
          signal.topFeatures = prediction.topFeatures;
        }
      } catch (e: any) {
        SignalGenerator.aiHealth.totalRequests++;
        SignalGenerator.aiHealth.failedConfirmations++;
        SignalGenerator.aiHealth.consecutiveFailures++;
        SignalGenerator.aiHealth.lastFailureReason = e.message || String(e);

        signal.aiWarning = true;
        signal.reasoning += ` [ML Evaluation Failed: ${e.message}]`;

        if (SignalGenerator.aiHealth.consecutiveFailures >= 5) {
          SignalGenerator.aiHealth.circuitBreakerTripped = true;
          SignalGenerator.aiEnabled = false;
        }
      }
    }

    return signal;
  }

  /**
   * Compute a live confidence score every cycle, even when no full signal fires.
   * Shows how close each indicator condition is to triggering, giving a dynamic
   * 0-100 readout that updates every trading cycle (no dead 50/50 state).
   */
  computeLiveConfidence(df: any[], regime: RegimeType): { score: number; side: string; indicators: string[]; distances: Record<string, number> } {
    if (df.length < 2) return { score: 0, side: 'neutral', indicators: ['Waiting for data...'], distances: {} };

    const data = df[df.length - 1];
    const distances: Record<string, number> = {};
    const indicators: string[] = [];
    let totalScore = 0;
    let side = 'neutral';

    // For sideways regime: measure proximity to Bollinger Band extremes
    if (regime === RegimeType.SIDEWAYS || regime === RegimeType.UNCERTAIN) {
      const bbRange = data.bb_upper - data.bb_lower;
      const midPoint = (data.bb_upper + data.bb_lower) / 2;

      if (bbRange > 0) {
        // How close to lower band? (0 = midpoint, 1 = at/lower band + RSI/stoch conditions)
        const proximityToLower = Math.max(0, Math.min(1, (midPoint - data.close) / (midPoint - data.bb_lower)));
        // How close to upper band?
        const proximityToUpper = Math.max(0, Math.min(1, (data.close - midPoint) / (data.bb_upper - midPoint)));

        if (proximityToLower > 0.3 || data.close <= data.bb_lower * 1.01) {
          side = 'buy';
          // BB proximity: 0-30 pts (scaled)
          const bbScore = Math.round(proximityToLower * 30);
          totalScore += bbScore;
          distances.bb_lower_proximity = proximityToLower;
          if (proximityToLower > 0.7) indicators.push('Near BB Lower');
          else if (proximityToLower > 0.3) indicators.push('Approaching BB Lower');

          // RSI oversold proximity: 0-25 pts
          if (data.rsi_14 < 50) {
            const rsiDist = Math.max(0, Math.min(1, (50 - data.rsi_14) / 50));
            const rsiScore = Math.round(rsiDist * 25);
            totalScore += rsiScore;
            distances.rsi_oversold = rsiDist;
            if (rsiDist > 0.5) indicators.push('RSI Oversold');
          }

          // WaveTrend oversold proximity: 0-20 pts (replaces StochRSI)
          if (data.wave_trend_1 != null && data.wave_trend_1 < 0) {
            const wtDist = Math.max(0, Math.min(1, (-data.wave_trend_1) / 60));
            const wtScore = Math.round(wtDist * 20);
            totalScore += wtScore;
            distances.wt_oversold = wtDist;
            if (wtDist > 0.5 || data.wt_oversold) indicators.push('WaveTrend Oversold');
          }
        }
        else if (proximityToUpper > 0.3 || data.close >= data.bb_upper * 0.995) {
          side = 'sell';
          const bbScore = Math.round(proximityToUpper * 30);
          totalScore += bbScore;
          distances.bb_upper_proximity = proximityToUpper;
          if (proximityToUpper > 0.7) indicators.push('Near BB Upper');
          else if (proximityToUpper > 0.3) indicators.push('Approaching BB Upper');

          // RSI overbought proximity
          if (data.rsi_14 > 50) {
            const rsiDist = Math.max(0, Math.min(1, (data.rsi_14 - 50) / 50));
            const rsiScore = Math.round(rsiDist * 25);
            totalScore += rsiScore;
            distances.rsi_overbought = rsiDist;
            if (rsiDist > 0.5) indicators.push('RSI Overbought');
          }

          // WaveTrend overbought proximity (replaces StochRSI)
          if (data.wave_trend_1 != null && data.wave_trend_1 > 0) {
            const wtDist = Math.max(0, Math.min(1, data.wave_trend_1 / 60));
            const wtScore = Math.round(wtDist * 20);
            totalScore += wtScore;
            distances.wt_overbought = wtDist;
            if (wtDist > 0.5 || data.wt_overbought) indicators.push('WaveTrend Overbought');
          }
        } else {
          // Near midpoint — score based on RSI/stoch direction sentiment
          side = data.rsi_14 > 55 ? 'sell' : data.rsi_14 < 45 ? 'buy' : 'neutral';
          const rsiMomentum = Math.abs(data.rsi_14 - 50) * 0.4;
          totalScore += Math.round(rsiMomentum);
          distances.rsi_midpoint = Math.abs(data.rsi_14 - 50) / 50;
          indicators.push('BB Midpoint');
        }
      }

      // Volume pressure veto — VPI strongly opposed to the buy side (Block 5)
      if (side === 'buy' && data.vpi <= -0.60) {
        totalScore = Math.round(totalScore * 0.5);
        indicators.push('VPI Selling Pressure');
      }
    }

    // Cap at 100
    totalScore = Math.min(100, Math.max(0, totalScore));

    return { score: totalScore, side, indicators, distances };
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

    // RSI Momentum (20%) — RR-RSI flags (Block 5), legacy fallback
    const rsiBull = data.rr_bullish_momentum ?? (data.rsi_14 > 50 && data.rsi_14 < 75);
    const rsiOB = data.rr_overbought ?? (data.rsi_14 >= 75);
    if (rsiBull) {
      score += 20;
      indicators.push('RSI Momentum');
    } else if (rsiOB) {
      score += 5;
      indicators.push('RSI Overbought');
    }

    // Volume Confirmation (20%) — VPI replaces raw volume ratio (Block 5)
    if (data.vpi >= 0.60) {
      score += 20;
      indicators.push('VPI Strong Buying');
    }

    // Timing: WaveTrend (15%) — replaces StochRSI
    if (data.wt_oversold || data.wt_cross_up) {
      score += 15;
      indicators.push('WaveTrend Oversold/CrossUp');
    } else if (data.wave_trend_1 != null && data.wave_trend_1 < 0) {
      score += 5;
      indicators.push('WaveTrend Below Zero');
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
        if (data.rr_oversold ?? (data.rsi_14 < 40)) {
          score += 60;
          indicators.push('Mean Reversion (BB/VWAP/RR-RSI)');
        }
      }
    }
    // Strategy B: Momentum continuation (40% weight)
    else if (data.close > data.ema_9 && data.ema_9 > data.ema_21) {
      if (data.rr_bullish_momentum ?? (data.rsi_14 > 50 && data.rsi_14 < 70)) {
        if (data.vpi >= 0.60) {
          score += 40;
          indicators.push('Momentum Breakout');
        }
      }
    }

    // Volume confirmation boost — VPI (Block 5)
    if (data.close > data.open && data.vpi >= 0.25) {
      score += 15;
      indicators.push('Bullish VPI');
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
        if (data.rr_overbought ?? (data.rsi_14 > 60)) {
          score += 50;
          indicators.push('Resistance Rejection');
        }
      }
    } else if (data.rr_overbought ?? (data.rsi_14 > 65 && data.rsi_14 < 75)) {
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
    let side: 'buy' | 'sell' | 'neutral' = 'buy';
    const indicators: string[] = [];

    // Use continuous proximity scoring instead of hard binary gates.
    // Measures how close price is to BB band extremes with proportional scoring.
    const bbRange = data.bb_upper - data.bb_lower;
    const midPoint = (data.bb_upper + data.bb_lower) / 2;

    if (bbRange > 0) {
      // Proximity to lower band: 0 = at midpoint, 1 = at/breached lower band
      const proximityToLower = Math.max(0, Math.min(1, (midPoint - data.close) / (midPoint - data.bb_lower)));
      // Proximity to upper band
      const proximityToUpper = Math.max(0, Math.min(1, (data.close - midPoint) / (data.bb_upper - midPoint)));

      if (proximityToLower > 0.3) {
        // Long setup: proportional score 0-30 based on BB proximity
        const bbScore = Math.round(proximityToLower * 30);
        score += bbScore;
        if (proximityToLower > 0.8) indicators.push('Near BB Lower');
        else if (proximityToLower > 0.5) indicators.push('Approaching BB Lower');
        else indicators.push('BB Lower Bias');
        side = 'buy';

        // RSI oversold: 0-25 pts (proportional)
        if (data.rsi_14 < 50) {
          const rsiDist = Math.max(0, Math.min(1, (50 - data.rsi_14) / 50));
          const rsiScore = Math.round(rsiDist * 25);
          score += rsiScore;
          if (rsiDist > 0.5) indicators.push('RSI Oversold');
        }

        // WaveTrend oversold: 0-20 pts (proportional) — replaces StochRSI
        if (data.wave_trend_1 != null && data.wave_trend_1 < 0) {
          const wtDist = Math.max(0, Math.min(1, (-data.wave_trend_1) / 60));
          const wtScore = Math.round(wtDist * 20);
          score += wtScore;
          if (wtDist > 0.5 || data.wt_oversold) indicators.push('WaveTrend Oversold');
        }
      }
      else if (proximityToUpper > 0.3) {
        // Short setup: proportional score 0-30 based on BB proximity
        const bbScore = Math.round(proximityToUpper * 30);
        score += bbScore;
        if (proximityToUpper > 0.8) indicators.push('Near BB Upper');
        else if (proximityToUpper > 0.5) indicators.push('Approaching BB Upper');
        else indicators.push('BB Upper Bias');
        side = 'sell';

        // RSI overbought: 0-25 pts (proportional)
        if (data.rsi_14 > 50) {
          const rsiDist = Math.max(0, Math.min(1, (data.rsi_14 - 50) / 50));
          const rsiScore = Math.round(rsiDist * 25);
          score += rsiScore;
          if (rsiDist > 0.5) indicators.push('RSI Overbought');
        }

        // WaveTrend overbought: 0-20 pts (proportional) — replaces StochRSI
        if (data.wave_trend_1 != null && data.wave_trend_1 > 0) {
          const wtDist = Math.max(0, Math.min(1, data.wave_trend_1 / 60));
          const wtScore = Math.round(wtDist * 20);
          score += wtScore;
          if (wtDist > 0.5 || data.wt_overbought) indicators.push('WaveTrend Overbought');
        }
      } else {
        // Near midpoint — score based on RSI direction
        side = data.rsi_14 > 55 ? 'sell' : data.rsi_14 < 45 ? 'buy' : 'neutral';
        const rsiMomentum = Math.abs(data.rsi_14 - 50) * 0.4;
        score += Math.round(rsiMomentum);
        indicators.push('BB Midpoint');
      }
    }

    // Volume pressure veto — VPI strongly opposed to trade side (Block 5)
    if ((side === 'buy' && data.vpi <= -0.60) || (side === 'sell' && data.vpi >= 0.60)) {
      score = Math.round(score * 0.5);
      indicators.push('VPI Opposing Pressure');
    }

    // De-risk when direction is uncertain
    if (side === 'neutral') score = Math.round(score * 0.5);

    if (score >= 10) {
      const { stopLoss, takeProfit } = this.calculateATRAdjustedLevels(data.close, data.atr, side === 'neutral' ? 'buy' : side, riskMode);
      const confidence = Math.min(100, Math.max(0, score));
      return {
        symbol,
        side: side === 'neutral' ? 'buy' : side,
        confidence,
        entryPrice: data.close,
        stopLoss,
        takeProfit,
        reasoning: `Sideways: Score ${confidence} - ${indicators.join(', ')} (ATR-adjusted)`,
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
