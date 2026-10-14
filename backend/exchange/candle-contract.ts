import { SUPPORTED_SPOT_SYMBOLS } from '../config/supported-spot-symbols.js';

export const CANDLE_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};
export interface MarketCandle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
  symbol?: string; timeframe?: string; quote?: string; provider?: string;
  volumeAvailable?: boolean; finalized?: boolean; fetchedAt?: number;
}

export function assertCandleRequest(symbol: string, timeframe: string): void {
  if (!(SUPPORTED_SPOT_SYMBOLS as readonly string[]).includes(symbol)) throw new Error(`Unsupported market symbol: ${symbol}`);
  if (!CANDLE_INTERVAL_MS[timeframe]) throw new Error(`Unsupported candle timeframe: ${timeframe}`);
}

/** Validate observed OHLCV at the live boundary; historical reads do not use this age gate. */
export function validateLiveCandles(rows: MarketCandle[], symbol: string, timeframe: string, provider: string, now = Date.now()): MarketCandle[] {
  assertCandleRequest(symbol, timeframe);
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ms = CANDLE_INTERVAL_MS[timeframe];
  const quote = symbol.split('/')[1];
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
      || c.time <= 0 || c.time % ms !== 0 || c.time > now
      || Math.min(c.open, c.high, c.low, c.close) <= 0 || c.volume < 0
      || c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)
      || c.volumeAvailable === false || (c.symbol && c.symbol !== symbol)
      || (c.timeframe && c.timeframe !== timeframe) || (c.quote && c.quote !== quote)
      || (i > 0 && c.time - sorted[i - 1].time !== ms)) {
      throw new Error(`Invalid OHLCV contract for ${symbol} ${timeframe} from ${provider}`);
    }
  }
  const latest = sorted.at(-1)!;
  if (now - latest.time > ms * 2 + 60_000 || (latest.fetchedAt != null && (now - latest.fetchedAt > 120_000 || latest.fetchedAt > now + 5000))) {
    throw new Error(`Stale candles for ${symbol} ${timeframe} from ${provider}`);
  }
  return sorted.map(c => ({ ...c, symbol, timeframe, quote, provider: c.provider || provider,
    volumeAvailable: true, fetchedAt: c.fetchedAt ?? now, finalized: c.finalized ?? c.time + ms <= now }));
}
