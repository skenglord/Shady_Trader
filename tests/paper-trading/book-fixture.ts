import { PaperTradingService } from '../../backend/paper-trading/paper-trading-service';

// Deterministic exchange adapter for unit tests only. Production paper trading
// always receives its book snapshots from ExchangeConnector.
export function createPaperTradingTestService(): PaperTradingService {
  const mids: Record<string, number> = {
    'BTC/USDT': 50_000,
    'ETH/USDT': 2_000,
    'SOL/USDT': 100,
    'BNB/USDT': 500,
    'XRP/USDT': 1,
  };
  return new PaperTradingService(() => ({
    async getOrderBook(symbol) {
      const mid = mids[symbol];
      if (!mid) throw new Error(`No test market configured for ${symbol}`);
      return {
        symbol,
        timestamp: Date.now(),
        bids: Array.from({ length: 10 }, (_, i) => [mid - 0.5 - i * 0.1, 100] as [number, number]),
        asks: Array.from({ length: 10 }, (_, i) => [mid + 0.5 + i * 0.1, 100] as [number, number]),
      };
    },
  }));
}
