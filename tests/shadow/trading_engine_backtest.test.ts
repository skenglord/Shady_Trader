import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../backend/main.js';

function fakeRedis() {
  const redis = {
    status: 'ready',
    options: { host: 'memory', port: 0 },
    on: () => redis,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    keys: async () => [],
    mget: async () => [],
    eval: async () => 0,
    duplicate: () => redis
  };
  return redis;
}

function makeCandles(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i;
    return {
      time: i * 1000,
      open: base,
      high: i === 60 ? 175 : i === 80 ? 184 : base + 0.5,
      low: i === 60 ? 145 : i === 80 ? 165 : base - 0.5,
      close: base,
      volume: 1000
    };
  });
}

describe('TradingEngine.runBacktest exit lookup', () => {
  test('keeps deterministic trades and skip-ahead behavior with a time-to-index map', async () => {
    const candles = makeCandles(110);
    const signalsByIndex = new Map([
      [50, { symbol: 'BTC/USDT', side: 'buy', entryPrice: 150, stopLoss: 140, takeProfit: 165, confidence: 99 }],
      [75, { symbol: 'BTC/USDT', side: 'sell', entryPrice: 175, stopLoss: 185, takeProfit: 160, confidence: 99 }]
    ]);
    const wss = { clients: new Set(), on: () => wss };
    const engine = new TradingEngine(wss as any, fakeRedis() as any);

    engine.exchange = { getCandles: async () => candles } as any;
    engine.indicators.calculateAll = (rows: any[]) => rows.map((row) => ({ ...row, ema_9: row.close, rsi_14: 50 }));
    (engine.regimeDetector as any).detect = async () => ({ regime: 'strongbull', confidence: 1 });
    (engine.regimeDetector as any).shouldUpdateRegime = () => false;
    (engine.signalGenerator as any).generateSignal = async (_slice: any[], _regime: any, _symbol: string, _ai: boolean, _strategy: string, _mode: string) => {
      return signalsByIndex.get(_slice.length - 1) || null;
    };

    const result = await engine.runBacktest('moderate', {
      confidenceThreshold: 0,
      slMultiplier: 1,
      tpMultiplier: 1,
      leverage: 1
    });

    assert.deepEqual(result.trades, [
      {
        symbol: 'BTC/USDT',
        side: 'buy',
        entryPrice: 150,
        stopLoss: 140,
        takeProfit: 160,
        exitPrice: 160,
        exitTime: 60000,
        pnl: (160 - 150) / 150 * 100,
        status: 'profit',
        time: 50000,
        confidence: 99
      },
      {
        symbol: 'BTC/USDT',
        side: 'sell',
        entryPrice: 175,
        stopLoss: 185,
        takeProfit: 165,
        exitPrice: 165,
        exitTime: 80000,
        pnl: (175 - 165) / 175 * 100,
        status: 'profit',
        time: 75000,
        confidence: 99
      }
    ]);
    assert.equal(result.trades.length, 2);
    assert.equal(result.regimeChanges.length, 1);

    const closedTrades = result.trades.filter((trade: any) => trade.exitPrice !== null && trade.status !== 'expired');
    const derivedTotalPnl = Number(closedTrades.reduce((sum: number, trade: any) => sum + trade.pnl, 0).toFixed(4));
    assert.equal(derivedTotalPnl, 12.381);
  });
});
