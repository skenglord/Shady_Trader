import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskMode } from '../../backend/risk/manager.js';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';

describe('position symbol price isolation', () => {
  test('prices an older-symbol position from that symbol after pair switch', async () => {
    const trader = new ShadowTrader();
    const mode = RiskMode.MODERATE;
    const trade: any = {
      id: 'btc-position', symbol: 'BTC/USDT', side: 'buy', amount: 1,
      price: 100, leverage: 1, stopLoss: 90, takeProfit: 110,
      initialStopLoss: 90, isRunner: false, candlesHeld: 0,
    };
    trader.portfolios[mode].openTrades.push(trade);
    const requested: string[] = [];
    const exchange = {
      getCandles: async (symbol: string) => {
        requested.push(symbol);
        return [{ time: 200, close: 100.5 }];
      },
    };

    // ETH's current-cycle price is above the BTC take-profit; BTC is not.
    await trader.updatePositions(120, mode, undefined, exchange, { time: 200 }, 'ETH/USDT', '5m');

    assert.deepEqual(requested, ['BTC/USDT']);
    assert.equal(trader.portfolios[mode].openTrades.length, 1);
    assert.equal(trade.lastUpdateTime, 200);
  });

  test('preserves an older-symbol position when its own price is unavailable', async () => {
    const trader = new ShadowTrader();
    const mode = RiskMode.MODERATE;
    trader.portfolios[mode].openTrades.push({
      id: 'btc-position-no-price', symbol: 'BTC/USDT', side: 'buy', amount: 1,
      price: 100, leverage: 1, stopLoss: 90, takeProfit: 110,
      initialStopLoss: 90, isRunner: false, candlesHeld: 0,
    });
    await trader.updatePositions(120, mode, undefined, { getCandles: async () => [] }, { time: 200 }, 'ETH/USDT', '5m');
    assert.equal(trader.portfolios[mode].openTrades.length, 1);
  });
});
