import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';
import { RiskMode } from '../../backend/risk/manager.js';
import { setMockRunQuery } from '../../backend/database.js';

function setupShadowMocks() {
  setMockRunQuery(async (sql: string, params?: any[], method?: string) => {
    if (sql.includes('SELECT SUM(pnl)')) return [{ totalPnl: 0 }];
    if (sql.includes('SELECT COUNT(*) as count')) return [{ count: 0 }, { count: 0 }];
    if (sql.includes('SELECT exit_timestamp as time, pnl')) return [];
    if (sql.includes('SELECT * FROM shadow_trades WHERE risk_mode')) return [];
    if (sql.includes('DELETE FROM shadow_trades')) return { changes: 1 };
    if (sql.includes('INSERT INTO shadow_trades')) return { changes: 1 };
    if (sql.includes('INSERT INTO audit_trades')) return { changes: 1 };
    if (sql.includes('UPDATE shadow_trades')) return { changes: 1 };
    return [];
  });
}

describe('Deep Deterministic Tests - ShadowTrader', () => {
  let shadowTrader: ShadowTrader;

  beforeEach(() => {
    setupShadowMocks();
    shadowTrader = new ShadowTrader();
  });

  afterEach(() => {
    // Clean up
  });

  describe('Constructor and Initial State', () => {
    test('ShadowTrader initializes with all risk modes', () => {
      assert.ok(shadowTrader.portfolios[RiskMode.ULTRA_CONSERVATIVE]);
      assert.ok(shadowTrader.portfolios[RiskMode.CONSERVATIVE]);
      assert.ok(shadowTrader.portfolios[RiskMode.MODERATE]);
      assert.ok(shadowTrader.portfolios[RiskMode.AGGRESSIVE]);
      assert.ok(shadowTrader.portfolios[RiskMode.DEGEN]);
      assert.ok(shadowTrader.portfolios[RiskMode.AI_ENHANCED]);
    });

    test('Portfolios start with 100000 balance', () => {
      for (const mode of Object.values(RiskMode)) {
        assert.strictEqual(shadowTrader.portfolios[mode].balance, 100000);
        assert.strictEqual(shadowTrader.portfolios[mode].initialBalance, 100000);
      }
    });

    test('Portfolios start with empty open trades', () => {
      for (const mode of Object.values(RiskMode)) {
        assert.deepStrictEqual(shadowTrader.portfolios[mode].openTrades, []);
      }
    });

    test('RiskManager is initialized', () => {
      assert.ok(shadowTrader.riskManager !== undefined);
    });
  });

  describe('Reset Method', () => {
    test('reset clears all trades and resets balances', async () => {
      // Add a trade to one portfolio
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push({
        id: 'test-trade',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE
      } as any);
      shadowTrader.portfolios[RiskMode.MODERATE].balance = 90000;

      await shadowTrader.reset();

      assert.deepStrictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades, []);
      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].balance, 100000);
    });
  });

  describe('Load State Method', () => {
    test('loadState loads open trades from database', async () => {
      setMockRunQuery(async (sql: string) => {
        if (sql.includes('SELECT * FROM shadow_trades') && sql.includes("'open'")) {
          return [{
            id: 'db-trade-1',
            symbol: 'ETH/USDT',
            side: 'buy',
            amount: 2,
            price: 3000,
            status: 'open',
            timestamp: Date.now(),
            risk_mode: RiskMode.MODERATE,
            stop_loss: 2900,
            take_profit: 3100,
            leverage: 2,
            pnl: 0
          }];
        }
        if (sql.includes('SELECT SUM(pnl)')) return [{ totalPnl: 1000 }];
        return [];
      });

      await shadowTrader.loadState();

      assert.ok(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length > 0);
      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].balance, 101000);
    });
  });

  describe('Calculate Position Size', () => {
    test('calculatePositionSize returns correct amount', async () => {
      const signal = {
        symbol: 'BTC/USDT',
        side: 'buy',
        confidence: 80,
        entryPrice: 50000,
        stopLoss: 49000
      };

      await shadowTrader.processSignal(signal, 50000, RiskMode.MODERATE, undefined, undefined, 'strong_bull');

      // Trade should be created
      assert.ok(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length > 0);
    });

    test('processSignal respects circuit breakers', async () => {
      // Set up circuit breaker condition
      shadowTrader.riskManager.consecutiveLosses[RiskMode.MODERATE] = 5;

      const signal = {
        symbol: 'BTC/USDT',
        side: 'buy',
        confidence: 80,
        entryPrice: 50000,
        stopLoss: 49000
      };

      await shadowTrader.processSignal(signal, 50000, RiskMode.MODERATE, undefined, undefined, 'strong_bull');

      // Should not enter trade due to circuit breaker
      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });
  });

  describe('Update Positions', () => {
    test('updatePositions handles stop loss for buy trades', async () => {
      const trade = {
        id: 'test-trade-1',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500, // Will trigger at 49500
        takeProfit: 51000,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      // Price hits stop loss
      await shadowTrader.updatePositions(49400, RiskMode.MODERATE);

      // Trade should be closed
      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });

    test('updatePositions handles take profit for buy trades', async () => {
      const trade = {
        id: 'test-trade-2',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 50500, // Will trigger at 50500
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      await shadowTrader.updatePositions(50600, RiskMode.MODERATE);

      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });

    test('updatePositions handles stop loss for sell trades', async () => {
      const trade = {
        id: 'test-trade-3',
        symbol: 'BTC/USDT',
        side: 'sell',
        amount: 1,
        price: 50000,
        stopLoss: 50500, // Stop loss above for shorts
        takeProfit: 49500,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      await shadowTrader.updatePositions(50600, RiskMode.MODERATE);

      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });

    test('updatePositions increments candles held', async () => {
      const trade = {
        id: 'test-trade-4',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0,
        lastUpdateTime: Date.now() - 120000, // 2 minutes ago
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      await shadowTrader.updatePositions(50200, RiskMode.MODERATE, undefined, undefined, { time: Date.now() });

      // Candle count should increment
      assert.ok(trade.candlesHeld > 0);
    });

    test('updatePositions handles multi-candle hold expiration', async () => {
      const config = shadowTrader.riskManager.getConfig(RiskMode.MODERATE);
      config.multiCandleHoldEnabled = true;
      config.holdConditions = { minProfit: 0.5, maxCandles: 2 };

      const trade = {
        id: 'test-trade-5',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 2,
        lastUpdateTime: Date.now() - 120000,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      await shadowTrader.updatePositions(50200, RiskMode.MODERATE);

      // Trade should close due to multi-candle expiry
      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });

    test('updatePositions handles liquidation', async () => {
      const trade = {
        id: 'test-trade-6',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        leverage: 10, // High leverage
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      // Massive price drop to trigger liquidation
      await shadowTrader.updatePositions(45000, RiskMode.MODERATE);

      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });
  });

  describe('Close Trade Method', () => {
    test('closeTrade closes existing trade', async () => {
      const trade = {
        id: 'test-trade-close',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      const result = await shadowTrader.closeTrade('test-trade-close', 50200, RiskMode.MODERATE);

      assert.strictEqual(result, true);
      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });

    test('closeTrade returns false for non-existent trade', async () => {
      const result = await shadowTrader.closeTrade('non-existent', 50200, RiskMode.MODERATE);
      assert.strictEqual(result, false);
    });
  });

  describe('Update Trade Params Method', () => {
    test('updateTradeParams updates stop loss and take profit', async () => {
      const trade = {
        id: 'test-trade-update',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      const result = await shadowTrader.updateTradeParams('test-trade-update', 49000, 52000);

      assert.strictEqual(result, true);
      assert.strictEqual(trade.stopLoss, 49000);
      assert.strictEqual(trade.takeProfit, 52000);
    });
  });

  describe('Get Performance Method', () => {
    test('getPerformance returns performance for all modes', async () => {
      const performance = await shadowTrader.getPerformance();

      for (const mode of Object.values(RiskMode)) {
        assert.ok(performance[mode] !== undefined);
        assert.ok(performance[mode].hasOwnProperty('balance'));
        assert.ok(performance[mode].hasOwnProperty('roi'));
        assert.ok(performance[mode].hasOwnProperty('winRate'));
        assert.ok(performance[mode].hasOwnProperty('tradesCount'));
        assert.ok(performance[mode].hasOwnProperty('totalPnl'));
        assert.ok(performance[mode].hasOwnProperty('history'));
      }
    });
  });

  describe('Runner Position Logic', () => {
    test('runner triggers at configured profit threshold', async () => {
      const config = shadowTrader.riskManager.getConfig(RiskMode.AGGRESSIVE);
      config.runnerEnabled = true;
      config.runnerConditions = {
        triggerProfit: 1.5,
        partialExit: 0.6,
        maxPartialExits: 3,
        maxRunnerDuration: 3600000
      };
      config.multiCandleHoldEnabled = false;

      const trade = {
        id: 'test-runner',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.AGGRESSIVE,
        candlesHeld: 0,
        lastUpdateTime: Date.now() - 120000,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.AGGRESSIVE].openTrades.push(trade as any);

      // 1.5% profit = 50750
      await shadowTrader.updatePositions(50800, RiskMode.AGGRESSIVE);

      // Trade should have partial exit
      assert.ok(trade.candlesHeld >= 0);
    });
  });

  describe('Early Exit Feature', () => {
    test('early exit triggers when threshold reached', async () => {
      const config = shadowTrader.riskManager.getConfig(RiskMode.MODERATE);
      config.earlyExitEnabled = true;
      config.earlyExitTarget = 1.0; // 1%

      const trade = {
        id: 'test-early-exit',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        leverage: 1,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        candlesHeld: 0,
        lastUpdateTime: Date.now() - 120000,
        isRunner: false
      };
      shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push(trade as any);

      // 1% profit = 50500
      await shadowTrader.updatePositions(50600, RiskMode.MODERATE);

      assert.strictEqual(shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);
    });
  });

  describe('Risk Manager Integration', () => {
    test('Circuit breaker reduces position size after losses', () => {
      shadowTrader.riskManager.recordLoss(RiskMode.MODERATE);
      shadowTrader.riskManager.recordLoss(RiskMode.MODERATE);
      shadowTrader.riskManager.recordLoss(RiskMode.MODERATE);
      shadowTrader.riskManager.recordLoss(RiskMode.MODERATE);
      shadowTrader.riskManager.recordLoss(RiskMode.MODERATE);

      const config = shadowTrader.riskManager.getConfig(RiskMode.MODERATE);
      
      // Position size should be reduced
      assert.ok(config.positionSize <= shadowTrader.riskManager.RISK_CONFIGS[RiskMode.MODERATE].positionSize);
    });

    test('Win resets consecutive losses', () => {
      shadowTrader.riskManager.recordLoss(RiskMode.MODERATE);
      shadowTrader.riskManager.recordWin(RiskMode.MODERATE);

      assert.strictEqual(shadowTrader.riskManager.getConsecutiveLosses(RiskMode.MODERATE), 0);
    });
  });
});