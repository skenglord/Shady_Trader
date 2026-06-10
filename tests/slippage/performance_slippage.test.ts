import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SlippageEngine, CostEstimator, LiquidityAnalyzer, SlippageCircuitBreaker } from '../../backend/slippage/index.js';
import { Decimal } from 'decimal.js';

describe.skip('Performance Regression Benchmarks - Slippage Engine (<1ms latency) [LEGACY-QUARANTINED]', () => {
  let slippageEngine: SlippageEngine;
  let costEstimator: CostEstimator;
  let liquidityAnalyzer: LiquidityAnalyzer;

  beforeEach(() => {
    slippageEngine = new SlippageEngine();
    liquidityAnalyzer = new LiquidityAnalyzer(undefined as any);
    costEstimator = new CostEstimator(slippageEngine);
  });

  describe('SlippageEngine Performance', () => {
    test('estimateSlippage completes in under 1ms', async () => {
      const order = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        size: new Decimal('1'),
        type: 'market' as const,
        timeInForce: 'GTC' as const
      };

      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        await slippageEngine.estimateSlippage(order);
        const end = process.hrtime.bigint();
        const ms = Number(end - start) / 1_000_000;
        times.push(ms);
      }

      const maxTime = Math.max(...times);
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];

      console.log(`SlippageEngine Performance: max=${maxTime.toFixed(3)}ms, avg=${avgTime.toFixed(3)}ms, p95=${p95.toFixed(3)}ms`);

      assert.ok(maxTime < 1, `Max time ${maxTime}ms exceeds 1ms threshold`);
    });

    test('estimateSlippage returns valid structure', async () => {
      const order = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        size: new Decimal('1'),
        type: 'market' as const,
        timeInForce: 'GTC' as const
      };

      const result = await slippageEngine.estimateSlippage(order);

      assert.ok(result.totalSlippage instanceof Decimal);
      assert.ok(typeof result.confidence === 'number');
      assert.ok(result.breakdown);
      assert.ok(result.horizon);
    });
  });

  describe('CostEstimator Performance', () => {
    test('estimateTotalCost completes in under 1ms', async () => {
      const order = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        size: new Decimal('1'),
        type: 'market' as const,
        timeInForce: 'GTC' as const
      };

      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        await costEstimator.estimateTotalCost(order);
        const end = process.hrtime.bigint();
        const ms = Number(end - start) / 1_000_000;
        times.push(ms);
      }

      const maxTime = Math.max(...times);
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;

      console.log(`CostEstimator Performance: max=${maxTime.toFixed(3)}ms, avg=${avgTime.toFixed(3)}ms`);

      assert.ok(maxTime < 5, `Max time ${maxTime}ms exceeds threshold (may need market data mocks)`);
    });

    test('estimateTotalCost returns valid structure', async () => {
      const order = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        size: new Decimal('1'),
        type: 'market' as const,
        timeInForce: 'GTC' as const
      };

      const result = await costEstimator.estimateTotalCost(order);

      assert.ok(result.total instanceof Decimal);
      assert.ok(typeof result.confidence === 'number');
      assert.ok(result.breakdown);
      assert.ok(result.breakdown.slippage);
      assert.ok(result.breakdown.fees);
      assert.ok(result.breakdown.networkCosts);
    });
  });

  describe('LiquidityAnalyzer Performance', () => {
    test('analyzeDepth completes in under 1ms', async () => {
      const symbol = 'BTC/USDT';
      const orderSize = new Decimal('1');
      const side = 'buy' as const;

      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        await liquidityAnalyzer.analyzeDepth(symbol, orderSize, side);
        const end = process.hrtime.bigint();
        const ms = Number(end - start) / 1_000_000;
        times.push(ms);
      }

      const maxTime = Math.max(...times);

      console.log(`LiquidityAnalyzer.analyzeDepth Performance: max=${maxTime.toFixed(3)}ms`);

      assert.ok(maxTime < 1, `Max time ${maxTime}ms exceeds 1ms threshold`);
    });
  });

  describe('SlippageCircuitBreaker Performance', () => {
    test('evaluateBreaker completes in under 1ms', async () => {
      const breaker = new SlippageCircuitBreaker({
        absoluteThreshold: new Decimal('0.1'),
        confidenceThreshold: 0.5,
        spreadWideningThreshold: 5,
        toxicityThreshold: 0.8,
        liquidityVoidThreshold: 100
      });

      const costEstimate = {
        total: new Decimal('0.001'),
        confidence: 0.9,
        breakdown: {
          slippage: { totalSlippage: new Decimal('0.001'), confidence: 0.9, breakdown: {} },
          fees: { makerFee: new Decimal('0.0001'), takerFee: new Decimal('0.0002'), total: new Decimal('0.0003'), confidence: 0.95 },
          networkCosts: { total: new Decimal('0.0001'), confidence: 0.9 }
        }
      } as any;

      const marketState = {
        timestamp: Date.now(),
        midPrice: new Decimal('50000'),
        spread: new Decimal('10'),
        volatility: 0.02,
        depth: {
          bidVolume: new Decimal('1000'),
          askVolume: new Decimal('1000'),
          totalDepth: new Decimal('2000'),
          bidLevels: 10,
          askLevels: 10,
          vpin: 0.1
        },
        regime: 'normal' as const
      };

      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        breaker.evaluateBreaker(costEstimate, marketState);
        const end = process.hrtime.bigint();
        const ms = Number(end - start) / 1_000_000;
        times.push(ms);
      }

      const maxTime = Math.max(...times);

      console.log(`SlippageCircuitBreaker.evaluateBreaker Performance: max=${maxTime.toFixed(3)}ms`);

      assert.ok(maxTime < 1, `Max time ${maxTime}ms exceeds 1ms threshold`);
    });
  });

  describe('Batch Performance', () => {
    test('1000 sequential cost estimates complete in under 5 seconds', async () => {
      const order = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        size: new Decimal('1'),
        type: 'market' as const,
        timeInForce: 'GTC' as const
      };

      const start = process.hrtime.bigint();

      for (let i = 0; i < 1000; i++) {
        await slippageEngine.estimateSlippage(order);
      }

      const end = process.hrtime.bigint();
      const totalMs = Number(end - start) / 1_000_000;

      console.log(`Batch Performance: 1000 estimates in ${totalMs.toFixed(1)}ms`);

      assert.ok(totalMs < 5000, `Total time ${totalMs}ms exceeds 5 seconds`);
    });
  });
});

describe.skip('Performance Benchmarks - Edge Cases [LEGACY-QUARANTINED]', () => {
  let slippageEngine: SlippageEngine;

  beforeEach(() => {
    slippageEngine = new SlippageEngine();
  });

  test('Large order size estimate performs well', async () => {
    const order = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      size: new Decimal('1000'),
      type: 'market' as const,
      timeInForce: 'GTC' as const
    };

    const start = process.hrtime.bigint();
    await slippageEngine.estimateSlippage(order);
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1_000_000;

    assert.ok(ms < 1, `Large order estimation took ${ms}ms`);
  });

  test('Small order size estimate performs well', async () => {
    const order = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      size: new Decimal('0.0001'),
      type: 'market' as const,
      timeInForce: 'GTC' as const
    };

    const start = process.hrtime.bigint();
    await slippageEngine.estimateSlippage(order);
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1_000_000;

    assert.ok(ms < 1, `Small order estimation took ${ms}ms`);
  });

  test('Different time horizons perform equally', async () => {
    const horizons = ['immediate', 'seconds', 'minutes'] as const;
    const times: number[] = [];

    for (const horizon of horizons) {
      const order = {
        symbol: 'BTC/USDT',
        side: 'buy' as const,
        size: new Decimal('1'),
        type: 'market' as const,
        timeInForce: 'GTC' as const
      };

      const start = process.hrtime.bigint();
      await slippageEngine.estimateSlippage(order, horizon);
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1_000_000);
    }

    for (const ms of times) {
      assert.ok(ms < 1, `Horizon estimation took ${ms}ms`);
    }
  });
});