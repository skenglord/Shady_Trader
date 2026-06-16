import { Candle } from '../../indicators/engine';

export interface DataPartition {
  inSample: Candle[];
  outOfSample: Candle[];
  foldIndex: number;
  totalFolds: number;
  isAnchored: boolean;
}

export interface PartitionConfig {
  inSampleRatio: number;
  stepSize: number;
  mode: 'anchored' | 'non-anchored';
  minInSampleSize: number;
  minOutOfSampleSize: number;
}

export class DataPartitioner {
  private readonly config: PartitionConfig;

  constructor(config: Partial<PartitionConfig> = {}) {
    this.config = {
      inSampleRatio: config.inSampleRatio ?? 0.7,
      stepSize: config.stepSize ?? 1,
      mode: config.mode ?? 'non-anchored',
      minInSampleSize: config.minInSampleSize ?? 50,
      minOutOfSampleSize: config.minOutOfSampleSize ?? 30,
    };
  }

  /**
   * Partition data into in-sample and out-of-sample sets
   * Anchored: Fixed in-sample, expanding out-of-sample (cumulative learning)
   * Non-anchored: Rolling fixed-width windows (pure walk-forward)
   */
  partition(data: Candle[]): DataPartition[] {
    if (data.length < this.config.minInSampleSize + this.config.minOutOfSampleSize) {
      throw new Error(`Insufficient data: need at least ${this.config.minInSampleSize + this.config.minOutOfSampleSize} candles, got ${data.length}`);
    }

    const partitions: DataPartition[] = [];
    const n = data.length;
    
    if (this.config.mode === 'anchored') {
      // Anchored walk-forward: fixed in-sample start, expanding
      const initialInSampleSize = Math.floor(n * this.config.inSampleRatio);
      let outOfSampleStart = initialInSampleSize;
      
      while (outOfSampleStart + this.config.minOutOfSampleSize <= n) {
        const inSample = data.slice(0, outOfSampleStart);
        const outOfSampleEnd = Math.min(outOfSampleStart + this.config.stepSize, n);
        const outOfSample = data.slice(outOfSampleStart, outOfSampleEnd);
        
        if (inSample.length >= this.config.minInSampleSize && outOfSample.length >= this.config.minOutOfSampleSize) {
          partitions.push({
            inSample,
            outOfSample,
            foldIndex: partitions.length,
            totalFolds: Math.ceil((n - initialInSampleSize) / this.config.stepSize),
            isAnchored: true,
          });
        }
        
        outOfSampleStart += this.config.stepSize;
      }
    } else {
      // Non-anchored (rolling) walk-forward: fixed-width windows
      const windowSize = Math.floor(n * this.config.inSampleRatio);
      let start = 0;
      let foldIndex = 0;
      
      while (start + windowSize + this.config.minOutOfSampleSize <= n) {
        const inSample = data.slice(start, start + windowSize);
        const outOfSampleEnd = Math.min(start + windowSize + this.config.minOutOfSampleSize, n);
        const outOfSample = data.slice(start + windowSize, outOfSampleEnd);
        
        if (inSample.length >= this.config.minInSampleSize && outOfSample.length >= this.config.minOutOfSampleSize) {
          const totalFolds = Math.floor((n - windowSize) / this.config.stepSize);
          partitions.push({
            inSample,
            outOfSample,
            foldIndex,
            totalFolds,
            isAnchored: false,
          });
          foldIndex++;
        }
        
        start += this.config.stepSize;
      }
    }

    return partitions;
  }

  /**
   * Regime-aware partitioning: ensures each fold preserves regime distribution
   */
  partitionByRegime(data: Candle[], regimes: string[]): DataPartition[] {
    if (data.length !== regimes.length) {
      throw new Error('Data and regimes length mismatch');
    }

    // Group indices by regime
    const regimeIndices: Record<string, number[]> = {};
    regimes.forEach((regime, idx) => {
      if (!regimeIndices[regime]) regimeIndices[regime] = [];
      regimeIndices[regime].push(idx);
    });

    // For each regime, partition its indices
    const regimePartitions: Record<string, DataPartition[]> = {};
    Object.entries(regimeIndices).forEach(([regime, indices]) => {
      const regimeData = indices.map(i => data[i]);
      const partitions = this.partition(regimeData);
      regimePartitions[regime] = partitions;
    });

    // Combine partitions across regimes
    const minFolds = Math.min(...Object.values(regimePartitions).map(p => p.length));
    const combined: DataPartition[] = [];

    for (let i = 0; i < minFolds; i++) {
      const inSample: Candle[] = [];
      const outOfSample: Candle[] = [];
      
      Object.values(regimePartitions).forEach(partitions => {
        const partition = partitions[i];
        inSample.push(...partition.inSample);
        outOfSample.push(...partition.outOfSample);
      });

      // Sort by time to maintain temporal order
      inSample.sort((a, b) => a.time - b.time);
      outOfSample.sort((a, b) => a.time - b.time);

      combined.push({
        inSample,
        outOfSample,
        foldIndex: i,
        totalFolds: minFolds,
        isAnchored: this.config.mode === 'anchored',
      });
    }

    return combined;
  }

  /**
   * Validate partition integrity
   */
  validatePartition(partition: DataPartition): boolean {
    const { inSample, outOfSample } = partition;
    
    // Check minimum sizes
    if (inSample.length < this.config.minInSampleSize) return false;
    if (outOfSample.length < this.config.minOutOfSampleSize) return false;
    
    // Check temporal ordering
    for (let i = 1; i < inSample.length; i++) {
      if (inSample[i].time <= inSample[i-1].time) return false;
    }
    for (let i = 1; i < outOfSample.length; i++) {
      if (outOfSample[i].time <= outOfSample[i-1].time) return false;
    }
    
    // Check no overlap
    const lastInSampleTime = inSample[inSample.length - 1].time;
    const firstOutOfSampleTime = outOfSample[0].time;
    if (lastInSampleTime >= firstOutOfSampleTime) return false;
    
    return true;
  }
}