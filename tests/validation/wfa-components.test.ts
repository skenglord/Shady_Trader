import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { DataPartitioner } from '../../backend/validation/wfa/data-partitioner.js';
import { OverfittingDetector } from '../../backend/validation/wfa/overfitting-detector.js';
import { StatisticalValidator } from '../../backend/validation/wfa/statistical-validator.js';
import { WFACheckpointManager } from '../../backend/validation/wfa/wfa-checkpoint.js';
import { RiskMode } from '../../backend/risk/manager.js';
import { apiRouter } from '../../backend/api/routes.js';
import type { Candle } from '../../backend/indicators/engine.js';
import type { OptimizationResult } from '../../backend/validation/wfa/rolling-optimizer.js';
import type { OverfittingDiagnostic } from '../../backend/validation/wfa/overfitting-detector.js';
import type { ValidationReport } from '../../backend/validation/wfa/statistical-validator.js';

function makeCandles(count: number, start = 100): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_700_000_000_000 + index * 60_000,
    open: start + index,
    high: start + index + 1,
    low: start + index - 1,
    close: start + index + 0.5,
    volume: 100 + index,
  }));
}

function makeResults(count: number): OptimizationResult[] {
  return Array.from({ length: count }, (_, index) => ({
    parameters: {
      mode: RiskMode.MODERATE,
      confidenceThreshold: 70 + index,
      stopLoss: 2,
      takeProfit: 3,
      positionSize: 0.05,
      earlyExitTarget: 1,
      holdMaxCandles: 5,
    },
    inSampleSharpe: 0.8 + index * 0.05,
    inSampleMaxDrawdown: 0.08,
    outOfSampleSharpe: 0.6 + index * 0.04,
    outOfSampleMaxDrawdown: 0.1 + index * 0.01,
    fitnessScore: 0.4 + index * 0.03,
    tradeCount: 10 + index,
    winRate: 0.55,
  }));
}

describe('WFA validation components', () => {
  test('data partitioner creates anchored, rolling, and regime-aware folds', () => {
    const candles = makeCandles(120);
    const rolling = new DataPartitioner({
      inSampleRatio: 0.7,
      stepSize: 10,
      mode: 'non-anchored',
      minInSampleSize: 50,
      minOutOfSampleSize: 20,
    });

    const rollingPartitions = rolling.partition(candles);
    assert.ok(rollingPartitions.length >= 2);
    assert.strictEqual(rollingPartitions.every((partition) => partition.isAnchored === false), true);
    assert.ok(rollingPartitions.every((partition) => rolling.validatePartition(partition)));
    assert.ok(rollingPartitions.every((partition) => partition.inSample[partition.inSample.length - 1].time < partition.outOfSample[0].time));

    const anchored = new DataPartitioner({
      inSampleRatio: 0.7,
      stepSize: 10,
      mode: 'anchored',
      minInSampleSize: 50,
      minOutOfSampleSize: 10,
    });
    const anchoredPartitions = anchored.partition(candles);
    assert.ok(anchoredPartitions.length >= 2);
    assert.ok(anchoredPartitions.every((partition) => partition.isAnchored === true));
    assert.strictEqual(anchoredPartitions[1].inSample.length > anchoredPartitions[0].inSample.length, true);

    const regimes = candles.map((_, index) => (index % 3 === 0 ? 'bull' : index % 3 === 1 ? 'bear' : 'sideways'));
    const regimePartitions = new DataPartitioner({
      inSampleRatio: 0.7,
      stepSize: 5,
      mode: 'non-anchored',
      minInSampleSize: 20,
      minOutOfSampleSize: 10,
    }).partitionByRegime(candles, regimes);
    assert.ok(regimePartitions.length > 0);
    assert.ok(regimePartitions.every((partition) => rolling.validatePartition(partition)));
  });

  test('overfitting detector reports metrics, stability, confidence, and recommendations', () => {
    const detector = new OverfittingDetector();
    const results = makeResults(8);
    const diagnostic = detector.analyzeOverfitting(results, []);

    assert.ok(diagnostic.metrics.divergenceRatio >= 0);
    assert.ok(diagnostic.metrics.correlationDecay >= 0);
    assert.ok(diagnostic.metrics.shapeTestPValue >= 0);
    assert.ok(diagnostic.metrics.complexityPenalty >= 0);
    assert.ok(diagnostic.metrics.overallOverfittingScore >= 0);
    assert.strictEqual(typeof diagnostic.metrics.isOverfitted, 'boolean');
    assert.ok(diagnostic.stability.overallStability >= 0);
    assert.ok(diagnostic.confidenceLevel >= 0);
    assert.ok(diagnostic.recommendations.length > 0);
  });

  test('statistical validator returns a complete validation report', async () => {
    const validator = new StatisticalValidator();
    const results = makeResults(12);
    const overfittingDiagnostic: OverfittingDiagnostic = {
      metrics: {
        divergenceRatio: 0.1,
        correlationDecay: 0.8,
        shapeTestPValue: 0.5,
        complexityPenalty: 1,
        overallOverfittingScore: 0.1,
        isOverfitted: false,
      },
      stability: {
        parameterStability: 0.9,
        performanceConsistency: 0.8,
        drawdownStability: 0.9,
        overallStability: 0.85,
      },
      recommendations: [],
      confidenceLevel: 0.8,
    };

    const report = await validator.validateOptimization(results, overfittingDiagnostic);

    assert.strictEqual(report.whiteRealityCheck.testName, 'White Reality Check');
    assert.strictEqual(report.hansenSPA.testName, 'Hansen Superior Predictive Ability');
    assert.strictEqual(report.probabilisticSharpeRatio.testName, 'Probabilistic Sharpe Ratio');
    assert.strictEqual(report.bootstrapAnalysis.confidenceLevel, 0.95);
    assert.strictEqual(report.bootstrapAnalysis.sampleSize, 1000);
    assert.ok(Array.isArray(report.falseDiscoveryRate.originalPValues));
    assert.ok(Array.isArray(report.falseDiscoveryRate.adjustedPValues));
    assert.ok(typeof report.validationPassed === 'boolean');
    assert.ok(report.recommendations.length > 0);
  });

  test('WFA checkpoint manager saves, loads, lists, stats, and deletes checkpoints', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wfa-checkpoint-test-'));
    try {
      const manager = new WFACheckpointManager(tempDir);
      const partitions = new DataPartitioner({
        inSampleRatio: 0.7,
        stepSize: 10,
        mode: 'non-anchored',
        minInSampleSize: 50,
        minOutOfSampleSize: 20,
      }).partition(makeCandles(120));
      const results = makeResults(3);
      const overfittingDiagnostic: OverfittingDiagnostic = {
        metrics: {
          divergenceRatio: 0,
          correlationDecay: 1,
          shapeTestPValue: 1,
          complexityPenalty: 0,
          overallOverfittingScore: 0,
          isOverfitted: false,
        },
        stability: {
          parameterStability: 1,
          performanceConsistency: 1,
          drawdownStability: 1,
          overallStability: 1,
        },
        recommendations: ['stable'],
        confidenceLevel: 1,
      };
      const validationReport: ValidationReport = {
        whiteRealityCheck: {
          testName: 'White Reality Check',
          statistic: 1,
          pValue: 0.1,
          isSignificant: true,
          interpretation: 'significant',
        },
        hansenSPA: {
          testName: 'Hansen Superior Predictive Ability',
          statistic: 1,
          pValue: 0.1,
          isSignificant: true,
          interpretation: 'significant',
        },
        probabilisticSharpeRatio: {
          testName: 'Probabilistic Sharpe Ratio',
          statistic: 0.99,
          pValue: 0.01,
          isSignificant: true,
          interpretation: 'significant',
        },
        bootstrapAnalysis: {
          sharpeRatioCI: [0.5, 0.9],
          maxDrawdownCI: [0.1, 0.2],
          winRateCI: [0.5, 0.7],
          confidenceLevel: 0.95,
          sampleSize: 10,
        },
        falseDiscoveryRate: {
          originalPValues: [0.01, 0.02],
          adjustedPValues: [0.02, 0.02],
          rejectedHypotheses: [true, true],
          criticalValue: 0.025,
        },
        overallValidationScore: 0.9,
        validationPassed: true,
        recommendations: ['passed'],
      };

      await manager.saveCheckpoint(
        'job-1',
        'BTC/USDT',
        RiskMode.MODERATE,
        partitions,
        5,
        results,
        overfittingDiagnostic,
        validationReport
      );

      const loaded = await manager.loadCheckpoint('job-1');
      assert.ok(loaded);
      assert.strictEqual(loaded?.jobId, 'job-1');
      assert.strictEqual(loaded?.symbol, 'BTC/USDT');
      assert.ok(await manager.listCheckpoints().then((items) => items.includes('job-1')));

      const stats = await manager.getCheckpointStats();
      assert.strictEqual(stats.totalCheckpoints, 1);
      assert.ok(stats.totalSize > 0);
      assert.strictEqual(stats.oldestCheckpoint, loaded?.timestamp);
      assert.strictEqual(stats.newestCheckpoint, loaded?.timestamp);

      await manager.deleteCheckpoint('job-1');
      assert.strictEqual(await manager.loadCheckpoint('job-1'), null);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('WFA API route ownership', { concurrency: false }, () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  test('retires the Fastify-style WFA controller instead of exposing stale endpoints', async () => {
    await request(app).get('/api/wfa/start').expect(410);
    await request(app).get('/api/wfa/status/job-1').expect(410);
    await request(app).get('/api/wfa/results').expect(410);
    await request(app).get('/api/wfa/summary').expect(410);
    await request(app).post('/api/wfa/cancel/job-1').expect(410);
  });
});
