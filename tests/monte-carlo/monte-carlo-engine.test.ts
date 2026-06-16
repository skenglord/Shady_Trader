import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { Matrix } from 'ml-matrix';
import { PathGenerator } from '../../backend/monte-carlo/engine/path-generator.js';
import { RiskCalculator } from '../../backend/monte-carlo/engine/risk-calculator.js';
import { CorrelationMatrix } from '../../backend/monte-carlo/engine/correlation-matrix.js';
import { MonteCarloEngine } from '../../backend/monte-carlo/engine/monte-carlo-engine.js';
import {
  BlackSwanScenario,
  FlashCrashScenario,
  LiquidityCrisisScenario,
  RegimeShiftScenario,
  StressTestRunner,
} from '../../backend/monte-carlo/engine/stress-test-engine.js';
import router from '../../backend/monte-carlo/api/monte-carlo.controller.js';
import { apiRouter } from '../../backend/api/routes.js';

function makeCandle(time: number, close: number) {
  return {
    time,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 100,
  };
}

const TEST_ADMIN_TOKEN = 'test-mc-admin-token-do-not-use-in-prod';
const TEST_TRADER_TOKEN = 'test-mc-trader-token-do-not-use-in-prod';
const originalEnv = { ...process.env };

function makeMonteCarloApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

function makeMonteCarloRouterApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function assertCloseTo(actual: number, expected: number, precision = 12) {
  assert.ok(Math.abs(actual - expected) < 0.5 * 10 ** -precision, `expected ${actual} to be close to ${expected}`);
}

describe('Monte Carlo engine utilities', () => {
  test('generates valid GBM and jump-diffusion paths', () => {
    const generator = new PathGenerator({
      initialPrice: 100,
      drift: 0.05,
      volatility: 0.2,
      timeSteps: 10,
      numPaths: 5,
      seed: 7,
    });

    const gbm = generator.generateGBM();
    assert.strictEqual(gbm.length, 55);
    assert.strictEqual(gbm[0], 100);
    assert.ok(Array.from(gbm).every((value) => Number.isFinite(value) && value > 0));
    assert.ok(generator.validatePath(gbm, 10));
    assert.strictEqual(generator.validatePath(new Float64Array([NaN, 1]), 1), false);

    const returns = generator.computeLogReturns(gbm, 10);
    assert.strictEqual(returns.length, 50);
    assert.ok(Array.from(returns).every(Number.isFinite));

    const jumps = generator.generateJumpDiffusion(0, 0, 0);
    assert.strictEqual(jumps.length, 55);
    assert.ok(generator.validatePath(jumps, 10));
  });

  test('calculates VaR, CVaR, tail risk, and loss distributions', () => {
    const calculator = new RiskCalculator();
    const losses = Array.from({ length: 100 }, (_, index) => index);

    const var90 = calculator.historicalVaR(losses, 0.9);
    assert.strictEqual(var90, 90);
    assert.strictEqual(calculator.monteCarloVaR(losses, 0.9), var90);
    assert.deepStrictEqual(losses.filter((loss) => loss >= var90), Array.from({ length: 10 }, (_, index) => index + 90));
    assert.strictEqual(calculator.conditionalVaR(losses, 0.9), 94.5);
    assert.ok(calculator.parametricVaR([-0.01, 0.02, 0.03, -0.02, 0.01, 0.04], 0.95, 1000) >= 0);
    assert.ok(calculator.cornishFisherVaR([-0.03, -0.01, 0.02, 0.04, -0.02, 0.03, 0.01, 0.05], 0.95, 1000) >= 0);
    assert.deepStrictEqual(calculator.componentVaR([1, 2, 3, 4], [1, 1, 1, 1]), [1, 1, 1, 1]);

    const paths = new Float64Array([100, 101, 100, 99, 98, 102, 103, 101, 100, 99]);
    const distribution = calculator.calculateLossDistribution(paths, 4, 1000);
    assert.strictEqual(distribution.length, 2);
    assert.ok(distribution.every((value) => value >= 0));

    const tail = calculator.calculateTailRisk([1, 2, 3, 4, 5], [0.9, 0.99]);
    assert.strictEqual(tail.worstCaseLoss, 5);
    assert.strictEqual(tail.var['90%'], 5);
    assert.strictEqual(tail.cvar['90%'], 5);

    const kupiec = calculator.kupiecTest([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 5, 0.95);
    assert.strictEqual(kupiec.failureRate, 0);
    assertCloseTo(kupiec.expectedRate, 0.05, 12);

    const backtest = calculator.backtestVaR([1, 1, 1, 1, 1, 1, 1, 1], [5, 5, 5, 5, 5, 5, 5, 5], 0.95);
    assert.strictEqual(backtest.unconditional, kupiec.passes);
    assert.strictEqual(backtest.independence, true);
  });

  test('computes covariance, stressed correlations, and correlated noise', () => {
    const returns = [
      [0.01, 0.02],
      [0.02, 0.01],
      [0.03, 0.015],
      [0.015, 0.03],
      [0.02, 0.02],
    ];
    const matrix = new CorrelationMatrix(returns, 'sample');
    const covariance = matrix.getCovariance();

    assert.strictEqual(covariance.length, 2);
    assert.strictEqual(covariance[0].length, 2);
    assert.ok(matrix.isPositiveDefinite());
    assert.ok(matrix.getConditionNumber() >= 1);

    const noise = matrix.generateCorrelatedNoise(3);
    assert.strictEqual(noise.length, 3);
    assert.strictEqual(noise[0].length, 2);

    const stressed = matrix.applyStress({ type: 'crisis', intensity: 2 });
    assert.ok(stressed.get(0, 1) <= 0.99);
    assert.strictEqual(stressed.get(0, 0), covariance[0][0]);
  });

  test('runs lightweight Monte Carlo simulation and VaR validation', async () => {
    const engine = new MonteCarloEngine();
    const result = await engine.simulate({
      portfolio: {
        positions: [
          { symbol: 'BTC/USDT', quantity: 1, currentPrice: 100 },
          { symbol: 'ETH/USDT', quantity: 2, currentPrice: 50 },
        ],
      },
      parameters: {
        timeHorizon: 1,
        confidenceLevels: [0.95, 0.99],
        numPaths: 50,
        model: 'gbm',
      },
    });

    assert.strictEqual(result.status, 'completed');
    assert.ok(result.jobId.startsWith('mc_'));
    assert.ok(result.result?.var['95%'] >= 0);
    assert.ok(result.result?.cvar['99%'] >= 0);
    assert.deepStrictEqual(Object.keys(result.result?.componentVaR ?? {}).sort(), ['BTC/USDT', 'ETH/USDT']);
    assert.strictEqual(result.result?.simulationStats.numPaths, 50);

    const status = await engine.getStatus(result.jobId);
    assert.strictEqual(status?.status, 'completed');
    assert.strictEqual(await engine.getStatus('missing'), null);

    const validation = await engine.validateVaR([-0.01, 0.02, -0.03, 0.04, -0.05], [0.04, 0.04, 0.04, 0.04, 0.04], 0.95);
    assert.ok(typeof validation.passes === 'boolean');
    assert.ok(typeof validation.pValue === 'number');
    assert.strictEqual(validation.failureRate, 0);
  });

  test('applies stress scenarios and reports worst case', async () => {
    const runner = new StressTestRunner();
    const baseMatrix = new Matrix([[1, 0.2], [0.2, 1]]);
    const blackSwan = new BlackSwanScenario(0.5);
    const flashCrash = new FlashCrashScenario(0.5);
    const liquidityCrisis = new LiquidityCrisisScenario(0.5);
    const regimeShift = new RegimeShiftScenario(0.5);

    const blackSwanShocks = blackSwan.applyShocks([0.01, 0.02, 0.03]);
    assert.strictEqual(blackSwanShocks.length, 3);
    blackSwanShocks.forEach((shock, index) => assertCloseTo(shock, [-0.02, -0.04, -0.06][index], 12));
    assert.ok(blackSwan.applyCorrelation(baseMatrix).get(0, 1) > 0.2);
    assert.strictEqual(blackSwan.applyTransactionCosts(10), 35);

    assert.deepStrictEqual(flashCrash.applyShocks([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07]), [0.01, 0.02, 0.03, -0.01, -0.01, -0.01, -0.01]);
    assert.strictEqual(flashCrash.applyCorrelation(baseMatrix).get(0, 1), 0.45);
    assert.strictEqual(flashCrash.applyTransactionCosts(10), 60);

    assert.strictEqual(liquidityCrisis.applyTransactionCosts(10), 60);
    assert.deepStrictEqual(regimeShift.applyShocks([0.01, 0.02]), [0, 0.01]);
    assert.ok(regimeShift.applyCorrelation(baseMatrix).get(0, 1) >= 0.2);
    assert.strictEqual(regimeShift.applyTransactionCosts(10), 25);

    runner.addScenario(blackSwan);
    const report = await runner.runAllScenarios(1000, 100000);
    assert.strictEqual(report.results.length, 1);
    assert.strictEqual(report.comparativeAnalysis.worstCaseScenario, 'black-swan');
    assert.ok(report.results[0].heatmap.length > 0);
  });

  test('Monte Carlo API health and validation routes are reachable', async () => {
    const app = makeMonteCarloRouterApp();

    const health = await request(app).get('/health').expect(200);
    assert.strictEqual(health.body.service, 'monte-carlo');
    assert.strictEqual(health.body.status, 'healthy');

    await request(app)
      .post('/simulate')
      .send({ portfolio: { positions: [] }, parameters: { timeHorizon: 1, confidenceLevels: [0.95], numPaths: 1000, model: 'gbm' } })
      .expect(400)
      .then((response) => {
        assert.strictEqual(response.body.error, 'Invalid request parameters');
      });

    await request(app)
      .post('/validate')
      .send({ historicalReturns: [1], varEstimates: [1, 2] })
      .expect(400)
      .then((response) => {
        assert.strictEqual(response.body.error, 'Arrays must have the same length');
      });

    await request(app)
      .post('/simulate')
      .send({
        portfolio: { positions: [{ symbol: 'BTC/USDT', quantity: 1, currentPrice: 100 }] },
        parameters: { timeHorizon: 1, confidenceLevels: [0.95], numPaths: 100001, model: 'gbm' },
      })
      .expect(400)
      .then((response) => {
        assert.strictEqual(response.body.error, 'Invalid request parameters');
      });

    await request(app)
      .post('/simulate')
      .send({
        portfolio: { positions: [{ symbol: 'BTC/USDT', quantity: 1, currentPrice: 100 }] },
        parameters: { timeHorizon: 1, confidenceLevels: [0.95], numPaths: 1000, model: 'gbm' },
        correlationMatrix: Array(11).fill(Array(11).fill(1)),
      })
      .expect(400)
      .then((response) => {
        assert.strictEqual(response.body.error, 'Invalid request parameters');
      });

    await request(app)
      .post('/validate')
      .send({ historicalReturns: Array(5001).fill(0.01), varEstimates: Array(5001).fill(0.01) })
      .expect(400)
      .then((response) => {
        assert.strictEqual(response.body.error, 'Validation input cannot exceed 5000 points');
      });
  });
});

describe('Monte Carlo API route ownership', { concurrency: false }, () => {
  let app: express.Application;

  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
    process.env.API_TRADER_TOKEN = TEST_TRADER_TOKEN;
    app = makeMonteCarloApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('mounts Monte Carlo routes under /api/mc with trader/admin role checks', async () => {
    await request(app).get('/api/mc/health').expect(401);

    await request(app)
      .get('/api/mc/health')
      .set('Authorization', `Bearer ${TEST_TRADER_TOKEN}`)
      .expect(200)
      .then((response) => {
        assert.strictEqual(response.body.service, 'monte-carlo');
        assert.strictEqual(response.body.status, 'healthy');
      });

    await request(app)
      .post('/api/mc/simulate')
      .set('Authorization', `Bearer ${TEST_TRADER_TOKEN}`)
      .send({
        portfolio: { positions: [{ symbol: 'BTC/USDT', quantity: 1, currentPrice: 100 }] },
        parameters: { timeHorizon: 1, confidenceLevels: [0.95], numPaths: 1000, model: 'gbm' },
      })
      .expect(403);

    await request(app)
      .post('/api/mc/simulate')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({
        portfolio: { positions: [{ symbol: 'BTC/USDT', quantity: 1, currentPrice: 100 }] },
        parameters: { timeHorizon: 1, confidenceLevels: [0.95], numPaths: 1000, model: 'gbm' },
      })
      .expect(202)
      .then((response) => {
        assert.strictEqual(response.body.status, 'completed');
        assert.ok(response.body.jobId?.startsWith('mc_'));
      });
  });
});
