import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { DataPartitioner, DataPartition } from '../../backend/validation/wfa/data-partitioner';
import { Candle } from '../../indicators/engine';

// Mock candle data for testing
function createMockCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 50000;

  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 1000; // Random price change
    price += change;

    candles.push({
      time: Date.now() + i * 60000, // 1 minute intervals
      open: price - 50,
      high: price + 100,
      low: price - 100,
      close: price,
      volume: Math.random() * 1000 + 500,
    });
  }

  return candles;
}

describe('DataPartitioner', () => {
  let partitioner: DataPartitioner;
  let testData: Candle[];

  beforeEach(() => {
    partitioner = new DataPartitioner();
    testData = createMockCandles(200); // 200 candles
  });

  describe('partition (anchored mode)', () => {
    test('should create anchored partitions correctly', () => {
      const partitions = partitioner.partition(testData);

      expect(partitions.length).toBeGreaterThan(0);
      expect(partitions[0].isAnchored).toBe(true);

      // Check first partition
      const firstPartition = partitions[0];
      expect(firstPartition.inSample.length).toBeGreaterThan(firstPartition.outOfSample.length);
      expect(firstPartition.foldIndex).toBe(0);

      // Check temporal ordering
      expect(partitioner.validatePartition(firstPartition)).toBe(true);
    });

    test('should respect minimum size requirements', () => {
      const smallData = createMockCandles(50); // Too small
      expect(() => partitioner.partition(smallData)).toThrow('Insufficient data');
    });

    test('should maintain temporal order', () => {
      const partitions = partitioner.partition(testData);

      for (const partition of partitions) {
        // Check in-sample temporal order
        for (let i = 1; i < partition.inSample.length; i++) {
          expect(partition.inSample[i].time).toBeGreaterThan(partition.inSample[i-1].time);
        }

        // Check out-of-sample temporal order
        for (let i = 1; i < partition.outOfSample.length; i++) {
          expect(partition.outOfSample[i].time).toBeGreaterThan(partition.outOfSample[i-1].time);
        }

        // Check no overlap
        const lastInSample = partition.inSample[partition.inSample.length - 1];
        const firstOutOfSample = partition.outOfSample[0];
        expect(lastInSample.time).toBeLessThan(firstOutOfSample.time);
      }
    });
  });

  describe('partition (non-anchored mode)', () => {
    beforeEach(() => {
      partitioner = new DataPartitioner({ mode: 'non-anchored' });
    });

    test('should create rolling partitions correctly', () => {
      const partitions = partitioner.partition(testData);

      expect(partitions.length).toBeGreaterThan(0);
      expect(partitions[0].isAnchored).toBe(false);

      // Check rolling window behavior
      for (let i = 1; i < partitions.length; i++) {
        expect(partitions[i].foldIndex).toBe(i);
      }
    });
  });

  describe('validatePartition', () => {
    test('should validate correct partitions', () => {
      const partitions = partitioner.partition(testData);

      for (const partition of partitions) {
        expect(partitioner.validatePartition(partition)).toBe(true);
      }
    });

    test('should reject invalid partitions', () => {
      const invalidPartition: DataPartition = {
        inSample: [],
        outOfSample: [],
        foldIndex: 0,
        totalFolds: 1,
        isAnchored: true,
      };

      expect(partitioner.validatePartition(invalidPartition)).toBe(false);
    });
  });

  describe('partitionByRegime', () => {
    test('should partition by regime correctly', () => {
      const regimes = testData.map((_, i) => i % 4 === 0 ? 'strong_bull' :
                                           i % 4 === 1 ? 'weak_bull' :
                                           i % 4 === 2 ? 'sideways' : 'bear');

      const partitions = partitioner.partitionByRegime(testData, regimes);

      expect(partitions.length).toBeGreaterThan(0);

      for (const partition of partitions) {
        expect(partitioner.validatePartition(partition)).toBe(true);
      }
    });

    test('should handle mismatched data and regimes', () => {
      const regimes = ['strong_bull']; // Too few regimes

      expect(() => partitioner.partitionByRegime(testData, regimes)).toThrow('length mismatch');
    });
  });

  describe('configuration', () => {
    test('should accept custom configuration', () => {
      const customPartitioner = new DataPartitioner({
        inSampleRatio: 0.8,
        stepSize: 2,
        mode: 'non-anchored',
        minInSampleSize: 100,
        minOutOfSampleSize: 50,
      });

      const largeData = createMockCandles(300);
      const partitions = customPartitioner.partition(largeData);

      expect(partitions.length).toBeGreaterThan(0);
    });
  });
});