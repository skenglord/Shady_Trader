import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { DataPartitioner, DataPartition } from '../../backend/validation/wfa/data-partitioner';
import { Candle } from '../../backend/indicators/engine';

function createMockCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 50000;
  for (let i = 0; i < count; i++) {
    price += (Math.random() - 0.5) * 1000;
    candles.push({ time: Date.now() + i * 60000, open: price - 50, high: price + 100, low: price - 100, close: price, volume: 1000 });
  }
  return candles;
}

describe('DataPartitioner', () => {
  let partitioner: DataPartitioner;
  let testData: Candle[];

  beforeEach(() => {
    partitioner = new DataPartitioner({ mode: 'anchored', stepSize: 30 });
    testData = createMockCandles(200);
  });

  test('creates anchored partitions correctly', () => {
    const partitions = partitioner.partition(testData);
    assert.ok(partitions.length > 0);
    assert.strictEqual(partitions[0].isAnchored, true);
    assert.ok(partitions[0].inSample.length > partitions[0].outOfSample.length);
    assert.strictEqual(partitions[0].foldIndex, 0);
    assert.strictEqual(partitioner.validatePartition(partitions[0]), true);
  });

  test('rejects insufficient data', () => {
    assert.throws(() => partitioner.partition(createMockCandles(50)), /Insufficient data/);
  });

  test('creates rolling partitions correctly', () => {
    const rolling = new DataPartitioner({ mode: 'non-anchored', stepSize: 30 });
    const partitions = rolling.partition(testData);
    assert.ok(partitions.length > 0);
    assert.strictEqual(partitions[0].isAnchored, false);
  });

  test('rejects invalid partition', () => {
    const invalidPartition: DataPartition = { inSample: [], outOfSample: [], foldIndex: 0, totalFolds: 1, isAnchored: true };
    assert.strictEqual(partitioner.validatePartition(invalidPartition), false);
  });

  test('handles regime partitioning and mismatches', () => {
    const regimes = testData.map((_, i) => ['strong_bull', 'weak_bull', 'sideways', 'bear'][i % 4]);
    const regimePartitioner = new DataPartitioner({ mode: 'anchored', stepSize: 10, minInSampleSize: 20, minOutOfSampleSize: 10 });
    const partitions = regimePartitioner.partitionByRegime(testData, regimes);
    assert.ok(partitions.length > 0);
    assert.throws(() => partitioner.partitionByRegime(testData, ['strong_bull']), /length mismatch/i);
  });
});
