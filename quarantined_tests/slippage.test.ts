import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SlippageEngine } from '../../backend/slippage/engine.js';
import { LiquidityAnalyzer } from '../../backend/slippage/liquidity-analyzer.js';
import { CostEstimator } from '../../backend/slippage/cost-estimator.js';
import { ImpactSimulator } from '../../backend/slippage/impact-simulator.js';
import { OrderRequest } from '../../backend/slippage/types.js';
import { Decimal } from 'decimal.js';

describe('SlippageEngine', () => {
  let engine: SlippageEngine;

  beforeEach(() => {
    engine = new SlippageEngine();
  });

  it('should estimate slippage for market order', async () => {
    const order: OrderRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      size: new Decimal(1),
      type: 'market',
      timeInForce: 'GTC'
    };

    const estimate = await engine.estimateSlippage(order);
    assert(estimate !== undefined);
    assert(estimate.totalSlippage instanceof Decimal);
    assert(estimate.confidence > 0);
    assert(estimate.confidence <= 1);
  });

  it('should handle different order types', async () => {
    const marketOrder: OrderRequest = {
      symbol: 'BTC/USDT',
      side: 'sell',
      size: new Decimal(0.5),
      type: 'market',
      timeInForce: 'IOC'
    };

    const limitOrder: OrderRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      size: new Decimal(0.5),
      type: 'limit',
      limitPrice: new Decimal(50000),
      timeInForce: 'GTC'
    };

    const marketEstimate = await engine.estimateSlippage(marketOrder);
    const limitEstimate = await engine.estimateSlippage(limitOrder);

    assert(marketEstimate !== undefined);
    assert(limitEstimate !== undefined);
  });
});

describe('LiquidityAnalyzer', () => {
  let analyzer: LiquidityAnalyzer;

  beforeEach(() => {
    analyzer = new LiquidityAnalyzer();
  });

  it('should analyze depth for order size', async () => {
    const orderSize = new Decimal(10);
    const profile = await analyzer.analyzeDepth('BTC/USDT', orderSize, 'buy');

    assert(profile !== undefined);
    assert(profile.effectiveDepth instanceof Decimal);
    assert(profile.resiliencyScore > 0);
    assert(['high', 'medium', 'low'].includes(profile.tier));
  });

  it('should handle different sides', async () => {
    const orderSize = new Decimal(5);

    const buyProfile = await analyzer.analyzeDepth('BTC/USDT', orderSize, 'buy');
    const sellProfile = await analyzer.analyzeDepth('BTC/USDT', orderSize, 'sell');

    assert(buyProfile !== undefined);
    assert(sellProfile !== undefined);
  });
});

describe('CostEstimator', () => {
  let engine: SlippageEngine;
  let estimator: CostEstimator;

  beforeEach(() => {
    engine = new SlippageEngine();
    estimator = new CostEstimator(engine);
  });

  it('should estimate total cost', async () => {
    const order: OrderRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      size: new Decimal(1),
      type: 'market',
      timeInForce: 'GTC'
    };

    const estimate = await estimator.estimateTotalCost(order);
    assert(estimate !== undefined);
    assert(estimate.total instanceof Decimal);
    assert(estimate.breakdown !== undefined);
    assert(estimate.confidence > 0);
  });

  it('should check trade execution', async () => {
    const order: OrderRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      size: new Decimal(1),
      type: 'market',
      timeInForce: 'GTC'
    };

    const maxCost = new Decimal(1000);
    const shouldExecute = await estimator.shouldExecuteTrade(order, maxCost);
    assert(typeof shouldExecute === 'boolean');
  });
});

describe('ImpactSimulator', () => {
  let engine: SlippageEngine;
  let simulator: ImpactSimulator;

  beforeEach(() => {
    engine = new SlippageEngine();
    simulator = new ImpactSimulator(engine);
  });

  it('should simulate execution scenarios', async () => {
    const order: OrderRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      size: new Decimal(1),
      type: 'market',
      timeInForce: 'GTC'
    };

    const scenarios = ['best_case', 'expected', 'worst_case'];
    const simulations = await simulator.simulateExecution(order, scenarios as any);

    assert(simulations.length === 3);
    simulations.forEach(sim => {
      assert(sim.scenario !== undefined);
      assert(typeof sim.expectedSlippage === 'number');
      assert(typeof sim.worstCaseSlippage === 'number');
      assert(typeof sim.executionTime === 'number');
    });
  });
});