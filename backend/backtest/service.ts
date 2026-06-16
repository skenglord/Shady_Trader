/**
 * Standalone backtest service — extracted from TradingEngine.runBacktest
 * so the validate worker and CLI can run in-house backtests without a full
 * TradingEngine (no WebSocketServer, no Redis required).
 *
 * Instantiate the needed engine components (IndicatorEngine, RegimeDetector,
 * SignalGenerator) which are all constructible standalone, then run the same
 * simulation loop as the live engine.
 */
import { IndicatorEngine, Candle } from '../indicators/engine.js';
import { RegimeDetector, RegimeType } from '../regime/detector.js';
import { SignalGenerator } from '../strategy/signal_generator.js';
import { RiskMode, DEFAULT_RISK_CONFIGS } from '../risk/manager.js';
import { logger } from '../logging/logger.js';

// ── Exported types ────────────────────────────────────────────────────

export interface BacktestMetrics {
  total_trades: number;
  wins: number;
  losses: number;
  sharpe: number;
  max_drawdown: number;
  profit_factor: number;
  win_rate: number;
  total_pnl: number;
}

export interface BacktestTrade {
  time: number;
  timestamp: number;
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number | null;
  exitTime: number | null;
  pnl: number;
  status: string;
  confidence?: number;
}

export interface StandaloneBacktestResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  regimeChanges: Array<{ time: number; regime: string }>;
  candleCount: number;
}

// ── Backtest runner ───────────────────────────────────────────────────

export async function runBacktestStandalone(
  candles: Candle[],
  mode: string = 'moderate',
  symbol: string = 'BTC/USDT',
  strategy: string = 'regime',
  activeMode: string = 'moderate',
): Promise<StandaloneBacktestResult> {
  // Normalise and deduplicate candles (same logic as TradingEngine.runBacktest)
  const uniqueMap = new Map<number, Candle>();
  for (const c of candles) uniqueMap.set(c.time, c);
  const sorted = Array.from(uniqueMap.values()).sort((a, b) => a.time - b.time);

  // Need at least 100 candles for warmup + meaningful signal window
  if (sorted.length < 100) {
    return {
      trades: [],
      metrics: emptyMetrics(),
      regimeChanges: [],
      candleCount: sorted.length,
    };
  }

  // Instantiate engine sub-components (all self-contained, no WSS/Redis)
  const indicators = new IndicatorEngine();
  const regimeDetector = new RegimeDetector();
  const signalGenerator = new SignalGenerator();

  // Resolve risk config from mode string
  const config =
    DEFAULT_RISK_CONFIGS[mode as RiskMode] ?? DEFAULT_RISK_CONFIGS[RiskMode.MODERATE];

  // Calculate indicators (synchronous)
  let df: any[];
  try {
    df = indicators.calculateAll(sorted);
  } catch (err: any) {
    logger.warn('[backtest-standalone] indicator calculation failed', {
      error: err?.message ?? String(err),
      candleCount: sorted.length,
    });
    return {
      trades: [],
      metrics: emptyMetrics(),
      regimeChanges: [],
      candleCount: sorted.length,
    };
  }

  const virtualTrades: BacktestTrade[] = [];
  const regimeChanges: Array<{ time: number; regime: string }> = [];
  let lastRegime: RegimeType | null = null;

  // Simulation loop (mirrors TradingEngine.runBacktest lines 1162-1255)
  for (let i = 50; i < df.length; i++) {
    const slice = df.slice(0, i + 1);

    // ── Regime detection ──
    const regimeResult = await regimeDetector.detect(slice, false);

    if (lastRegime === null) {
      lastRegime = regimeResult.regime;
      regimeChanges.push({ time: df[i].time, regime: lastRegime });
    } else if (regimeDetector.shouldUpdateRegime(lastRegime, regimeResult.regime, regimeResult.confidence)) {
      regimeChanges.push({ time: df[i].time, regime: regimeResult.regime });
      lastRegime = regimeResult.regime;
    }

    // ── Signal generation ──
    const signal = await signalGenerator.generateSignal(
      slice,
      lastRegime,
      symbol,
      false,          // no AI signal gen in standalone backtest
      strategy,
      activeMode,
    );

    if (!signal) continue;
    if ((signal.confidence ?? 0) < (config.confidenceThreshold ?? 0)) continue;

    // ── Trade simulation (TP / SL) ──
    const riskPerUnit = Math.abs(signal.entryPrice - signal.stopLoss);
    const riskConfig = config as Record<string, unknown>;
    const slMult = (riskConfig.slMultiplier ?? 1) as number;
    const tpMult = (riskConfig.tpMultiplier ?? 1) as number;
    const lev = config.leverage ?? 1;

    const adjustedStopLoss =
      signal.side === 'buy'
        ? signal.entryPrice - riskPerUnit * slMult
        : signal.entryPrice + riskPerUnit * slMult;
    const adjustedTakeProfit =
      signal.side === 'buy'
        ? signal.entryPrice + riskPerUnit * tpMult
        : signal.entryPrice - riskPerUnit * tpMult;

    let exitPrice: number | null = null;
    let exitTime: number | null = null;
    let pnl = 0;
    let status = 'expired';

    for (let j = i + 1; j < df.length; j++) {
      const candle = df[j];
      if (signal.side === 'buy') {
        if (candle.low <= adjustedStopLoss) {
          exitPrice = adjustedStopLoss;
          exitTime = candle.time;
          pnl = ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100 * lev;
          status = 'loss';
          break;
        }
        if (candle.high >= adjustedTakeProfit) {
          exitPrice = adjustedTakeProfit;
          exitTime = candle.time;
          pnl = ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100 * lev;
          status = 'profit';
          break;
        }
      } else {
        // sell side
        if (candle.high >= adjustedStopLoss) {
          exitPrice = adjustedStopLoss;
          exitTime = candle.time;
          pnl = ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100 * lev;
          status = 'loss';
          break;
        }
        if (candle.low <= adjustedTakeProfit) {
          exitPrice = adjustedTakeProfit;
          exitTime = candle.time;
          pnl = ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100 * lev;
          status = 'profit';
          break;
        }
      }
    }

    virtualTrades.push({
      time: df[i].time,
      timestamp: df[i].time,
      symbol,
      side: signal.side,
      entryPrice: signal.entryPrice,
      stopLoss: adjustedStopLoss,
      takeProfit: adjustedTakeProfit,
      exitPrice,
      exitTime,
      pnl,
      status,
      confidence: signal.confidence,
    });

    // Skip ahead to exit time to avoid overlapping trades
    if (exitTime) {
      const exitIndex = df.findIndex((c: any) => c.time === exitTime);
      if (exitIndex > i) i = exitIndex;
    }
  }

  const metrics = calculateMetrics(virtualTrades);

  logger.info('[backtest-standalone] completed', {
    trades: virtualTrades.length,
    winRate: metrics.win_rate,
    sharpe: metrics.sharpe,
    profitFactor: metrics.profit_factor,
  });

  return { trades: virtualTrades, metrics, regimeChanges, candleCount: sorted.length };
}

// ── Metrics calculator ────────────────────────────────────────────────

function calculateMetrics(trades: BacktestTrade[]): BacktestMetrics {
  const total = trades.length;
  if (total === 0) return emptyMetrics();

  const closedTrades = trades.filter((t) => t.exitPrice !== null && t.status !== 'expired');
  const closedCount = closedTrades.length;

  let wins = 0;
  let losses = 0;
  const returns: number[] = [];
  let grossProfit = 0;
  let grossLoss = 0;

  // Running equity curve for max drawdown
  const equity: number[] = [0];
  let peak = 0;
  let maxDrawdown = 0;

  for (const t of closedTrades) {
    if (t.pnl > 0) {
      wins++;
      grossProfit += t.pnl;
    } else {
      losses++;
      grossLoss += Math.abs(t.pnl);
    }

    returns.push(t.pnl);

    // Update equity curve (cumulative PnL)
    const cumPnl = equity[equity.length - 1] + t.pnl;
    equity.push(cumPnl);
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Win rate
  const winRate = closedCount > 0 ? wins / closedCount : 0;

  // Profit factor
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Sharpe ratio (annualised, assuming daily-ish returns)
  let sharpe = 0;
  if (returns.length > 1) {
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance =
      returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    // Annualise: multiply by sqrt(252) for daily returns
    // Since our candle frequency varies, use sqrt of count as rough freq scaling
    const annualisationFactor = Math.sqrt(252);
    sharpe = std > 0 ? (mean / std) * annualisationFactor : 0;
  }

  // Total PnL
  const totalPnl = returns.reduce((s, v) => s + v, 0);

  return {
    total_trades: total,
    wins,
    losses,
    sharpe: Number(sharpe.toFixed(4)),
    max_drawdown: Number(maxDrawdown.toFixed(4)),
    profit_factor: profitFactor === Infinity ? Infinity : Number(profitFactor.toFixed(4)),
    win_rate: Number(winRate.toFixed(4)),
    total_pnl: Number(totalPnl.toFixed(4)),
  };
}

function emptyMetrics(): BacktestMetrics {
  return {
    total_trades: 0,
    wins: 0,
    losses: 0,
    sharpe: 0,
    max_drawdown: 0,
    profit_factor: 0,
    win_rate: 0,
    total_pnl: 0,
  };
}
