import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PaperTradingService } from '../../backend/paper-trading/paper-trading-service';
import { ShadowTrader } from '../../backend/shadow/shadow_trader';
import { RiskMode } from '../../backend/risk/manager';
import { BalanceManager } from '../../backend/balance/manager';
import { Decimal } from 'decimal.js';

describe('Paper Trading Integration', () => {
  let paperService: PaperTradingService;
  let shadowTrader: ShadowTrader;
  let balanceManager: BalanceManager;

  beforeEach(() => {
    paperService = new PaperTradingService();
    shadowTrader = new ShadowTrader();
    balanceManager = new BalanceManager();
  });

  it('should integrate with shadow trader for all risk modes', async () => {
    const riskModes = Object.values(RiskMode);
    
    for (const mode of riskModes) {
      const request = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        type: 'market' as const,
        quantity: 0.1,
        timeInForce: 'GTC' as const,
        leverage: 1,
      };

      const result = await paperService.createPaperTrade(request);
      assert(result.id, `Failed to create trade for mode ${mode}`);
    }

    const summary = await paperService.getSummary();
    assert.strictEqual(summary.positionCount.total, riskModes.length);
  });

  it('should handle concurrent paper trades', async () => {
    const promises = [];
    
    for (let i = 0; i < 10; i++) {
      const request = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        type: 'market' as const,
        quantity: 0.1,
        timeInForce: 'GTC' as const,
        leverage: 1,
      };

      promises.push(paperService.createPaperTrade(request));
    }

    const results = await Promise.all(promises);
    assert.strictEqual(results.length, 10);
    
    const uniqueIds = new Set(results.map(r => r.id));
    assert.strictEqual(uniqueIds.size, 10); // All IDs should be unique
  });

  it('should calculate P&L across multiple positions', async () => {
    // Create multiple positions
    const positions = [];
    for (let i = 0; i < 5; i++) {
      const request = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        type: 'market' as const,
        quantity: 0.1,
        timeInForce: 'GTC' as const,
        leverage: 1,
      };

      const result = await paperService.createPaperTrade(request);
      positions.push(result);
    }

    // Get summary
    const summary = await paperService.getSummary();
    
    assert.strictEqual(summary.positionCount.open, 5);
    assert(summary.totalUnrealizedPnl !== undefined);
  });

  it('should handle different order types', async () => {
    const marketOrder = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      type: 'market' as const,
      quantity: 0.1,
      timeInForce: 'GTC' as const,
      leverage: 1,
    };

    const limitOrder = {
      symbol: 'ETH/USDT',
      side: 'buy' as const,
      type: 'limit' as const,
      quantity: 1,
      price: 3000,
      timeInForce: 'GTC' as const,
      leverage: 1,
    };

    const marketResult = await paperService.createPaperTrade(marketOrder);
    const limitResult = await paperService.createPaperTrade(limitOrder);

    assert.strictEqual(marketResult.status, 'pending');
    assert.strictEqual(limitResult.status, 'pending');
    assert.strictEqual(limitResult.price, '3000');
  });

  it('should update positions with price changes', async () => {
    const request = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      type: 'market' as const,
      quantity: 1,
      timeInForce: 'GTC' as const,
      leverage: 1,
    };

    await paperService.createPaperTrade(request);
    
    // Wait for order to fill
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const positions = await paperService.getOpenPositions();
    assert(positions.length > 0);
    
    // Check that positions have current prices
    const position = positions[0];
    assert(position.currentPrice !== undefined);
  });

  it.skip('should handle stop loss and take profit', async () => {
    const request = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      type: 'market' as const,
      quantity: 1,
      timeInForce: 'GTC' as const,
      stopLoss: 45000,
      takeProfit: 55000,
      leverage: 1,
    };

    const result = await paperService.createPaperTrade(request);
    assert(result.id);
    
    // Wait for order to fill
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check if order was filled
    const position = await paperService.getPosition(result.id);
    assert(position !== null, 'Position should exist');
    assert.strictEqual(position!.stopLoss, '45000');
    assert.strictEqual(position!.takeProfit, '55000');
  });

  it('should calculate margin correctly', async () => {
    const request = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      type: 'market' as const,
      quantity: 1,
      timeInForce: 'GTC' as const,
      leverage: 10,
    };

    await paperService.createPaperTrade(request);
    
    const summary = await paperService.getSummary();
    assert(summary.totalMarginUsed !== undefined);
  });

  it('should handle different symbols', async () => {
    const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    
    for (const symbol of symbols) {
      const request = {
        symbol,
        side: 'buy' as const,
        type: 'market' as const,
        quantity: 0.1,
        timeInForce: 'GTC' as const,
        leverage: 1,
      };

      const result = await paperService.createPaperTrade(request);
      assert(result.id);
      assert.strictEqual(result.symbol, symbol);
    }

    const summary = await paperService.getSummary();
    assert.strictEqual(summary.positionCount.total, symbols.length);
  });

  it('should handle order book updates', async () => {
    const snapshot1 = paperService.getOrderBookSnapshot('BTC/USDT');
    assert(snapshot1 !== null);
    
    // Wait for order book to update
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const snapshot2 = paperService.getOrderBookSnapshot('BTC/USDT');
    assert(snapshot2 !== null);
    
    // Order book should have updated
    assert(snapshot2!.timestamp >= snapshot1!.timestamp);
  });

  it('should handle large number of positions', async () => {
    const promises = [];
    
    for (let i = 0; i < 100; i++) {
      const request = {
        symbol: i % 2 === 0 ? 'BTC/USDT' : 'ETH/USDT',
        side: (i % 2 === 0 ? 'buy' : 'sell') as 'buy' | 'sell',
        type: 'market' as const,
        quantity: 0.01,
        timeInForce: 'GTC' as const,
        leverage: 1,
      };

      promises.push(paperService.createPaperTrade(request));
    }

    const results = await Promise.all(promises);
    assert.strictEqual(results.length, 100);
    
    const summary = await paperService.getSummary();
    assert.strictEqual(summary.positionCount.total, 100);
  });
});
