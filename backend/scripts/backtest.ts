// backend/scripts/backtest.ts
//
// Block 10: Backtest framework (Experiment A). CLI entrypoint that runs the
// full indicator → regime → signal pipeline over historical candles, simulates
// fills with computeFill(), and emits Phase-1 gate metrics.
//
//   npm run backtest -- --symbol BTCUSDT --start 2024-01-01 --end 2026-04-01 \
//     --mode conservative --slippage-enabled --fees-enabled \
//     --output reports/phase1_experiment_a.json

import fs from 'fs';
import path from 'path';
import { computeFill } from '../slippage/fillCalculator.js';

export interface BacktestMetrics {
  symbol: string;
  mode: string;
  tradeCount: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  totalPnlUSD: number;
}

export interface RawTrade { pnl: number; status?: string; side?: 'buy' | 'sell'; }

// Pure, unit-testable gate logic. pnl is a percentage per trade.
export function computeBacktestMetrics(
  symbol: string,
  mode: string,
  trades: RawTrade[],
  opts: { startingCapital?: number; slippageFrac?: number; feesEnabled?: boolean; slippageEnabled?: boolean } = {}
): BacktestMetrics {
  const cap = opts.startingCapital ?? 10000;
  const slip = opts.slippageEnabled ? (opts.slippageFrac ?? 0.0005) : 0;
  const feeFrac = opts.feesEnabled ? parseFloat(process.env.TAKER_FEE_RATE ?? '0.0006') : 0;
  // round-trip cost in percentage points (entry + exit)
  const costPct = (slip + feeFrac) * 2 * 100;

  const netPnls = trades.map(t => t.pnl - costPct);
  const tradeCount = netPnls.length;
  const wins = netPnls.filter(p => p > 0);
  const losses = netPnls.filter(p => p < 0);

  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const winRate = tradeCount > 0 ? wins.length / tradeCount : 0;

  // Sharpe over per-trade returns (not annualised)
  const mean = tradeCount > 0 ? netPnls.reduce((s, p) => s + p, 0) / tradeCount : 0;
  const variance = tradeCount > 0 ? netPnls.reduce((s, p) => s + (p - mean) ** 2, 0) / tradeCount : 0;
  const std = Math.sqrt(variance);
  const sharpeRatio = std > 0 ? mean / std : 0;

  // Equity curve & max drawdown (compounding per-trade % returns)
  let equity = cap, peak = cap, maxDd = 0;
  for (const p of netPnls) {
    equity *= (1 + p / 100);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    symbol, mode, tradeCount,
    winRate: round(winRate, 4),
    profitFactor: profitFactor === Infinity ? Infinity : round(profitFactor, 4),
    sharpeRatio: round(sharpeRatio, 4),
    maxDrawdownPct: round(maxDd * 100, 2),
    totalPnlUSD: round(equity - cap, 2),
  };
}

function round(n: number, d: number): number { const f = 10 ** d; return Math.round(n * f) / f; }

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = String(args.symbol ?? 'BTCUSDT');
  const mode = String(args.mode ?? 'conservative');
  const start = args.start ? new Date(String(args.start)).getTime() : undefined;
  const end = args.end ? new Date(String(args.end)).getTime() : undefined;

  // Lazy import to avoid pulling the engine into unit tests
  const { TradingEngine } = await import('../main.js');
  const { initDatabase } = await import('../database.js');
  const { WebSocketServer } = await import('ws');
  await initDatabase();
  const wss = new WebSocketServer({ noServer: true });
  const engine = new TradingEngine(wss as any);
  await engine.init();
  (engine as any).symbol = symbol;

  const { trades } = await engine.runBacktest(mode, undefined, start, end);
  // Apply realistic fills to each simulated trade's entry/exit
  const slippageFrac = parseFloat(process.env.SLIPPAGE_BASE_FRAC ?? '0.0005');
  for (const t of trades) {
    if (t.side && t.entryPrice) {
      const f = computeFill(t.side, t.entryPrice, Math.abs((t.takeProfit - t.entryPrice) / t.entryPrice), slippageFrac);
      t.filled = !f.skipped;
    }
  }

  const metrics = computeBacktestMetrics(symbol, mode, trades, {
    slippageEnabled: !!args['slippage-enabled'],
    feesEnabled: !!args['fees-enabled'],
    slippageFrac,
  });

  console.log(JSON.stringify(metrics, null, 2));

  if (args.output) {
    const outPath = path.resolve(String(args.output));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));
    console.log(`Wrote ${outPath}`);
  }

  // Experiment A gate: profitFactor > 1.0
  process.exit(metrics.profitFactor > 1.0 ? 0 : 1);
}

// Run only when invoked directly (not when imported by tests)
const invokedDirectly = !!process.argv[1] && /scripts[/\\]backtest\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) { main().catch((e) => { console.error(e); process.exit(2); }); }
