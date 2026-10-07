import { SlippageEngine } from '../../backend/slippage/engine.js';

// Test-only fixed-depth exchange fixture. It is never imported by application code.
export function createSlippageTestEngine(): SlippageEngine {
  const midpoint: Record<string, number> = { 'BTC/USDT': 50_000, 'ETH/USDT': 2_000, 'SOL/USDT': 100 };
  return new SlippageEngine(() => ({
    async getOrderBook(symbol) {
      const mid = midpoint[symbol];
      if (!mid) throw new Error(`No test book for ${symbol}`);
      return {
        timestamp: Date.now(),
        bids: Array.from({ length: 50 }, (_, i) => [mid - 0.5 - i * 0.1, 100] as [number, number]),
        asks: Array.from({ length: 50 }, (_, i) => [mid + 0.5 + i * 0.1, 100] as [number, number]),
      };
    },
  }));
}
