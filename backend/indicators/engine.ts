import { EMA, RSI, BollingerBands, ADX, StochasticRSI, MACD, SMA, ATR } from 'technicalindicators';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class IndicatorEngine {
  EMA_FAST = 9;
  EMA_MEDIUM = 21;
  EMA_SLOW = 50;
  RSI_PERIOD = 14;
  BB_PERIOD = 20;
  BB_STD_DEV = 2.0;
  ADX_PERIOD = 14;
  STOCH_RSI_PERIOD = 14;
  VOLUME_PERIOD = 20;

  private workerPool: Worker[] = [];
  private maxWorkers = 4;

  async calculateAllParallel(candles: Candle[]): Promise<any[]> {
    if (candles.length < 50) {
      throw new Error("Need at least 50 candles for indicator calculation");
    }

    // Split work across workers
    const chunkSize = Math.ceil(candles.length / this.maxWorkers);
    const promises: Promise<any[]>[] = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize + 50, candles.length); // Include overlap for accurate calculations
      const chunk = candles.slice(start, end);

      promises.push(this.calculateChunk(chunk, start));
    }

    const results = await Promise.all(promises);

    // Merge results
    const merged = this.mergeResults(results);
    return merged.filter(r => r.ema_50 !== null);
  }

  private async calculateChunk(candles: Candle[], offset: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'indicator-worker.js'), {
        workerData: { candles, offset }
      });

      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    });
  }

  private mergeResults(results: any[][]): any[] {
    // Simple merge - take the longest result and fill gaps
    const maxLength = Math.max(...results.map(r => r.length));
    const merged = new Array(maxLength);

    for (let i = 0; i < maxLength; i++) {
      for (const result of results) {
        if (result[i]) {
          merged[i] = result[i];
          break;
        }
      }
    }

    return merged;
  }

  calculateAll(candles: Candle[]) {
    if (candles.length < 50) {
      throw new Error("Need at least 50 candles for indicator calculation");
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const ema9 = EMA.calculate({ period: this.EMA_FAST, values: closes });
    const ema21 = EMA.calculate({ period: this.EMA_MEDIUM, values: closes });
    const ema50 = EMA.calculate({ period: this.EMA_SLOW, values: closes });

    const rsi14 = RSI.calculate({ period: this.RSI_PERIOD, values: closes });

    const bb = BollingerBands.calculate({ period: this.BB_PERIOD, stdDev: this.BB_STD_DEV, values: closes });

    const adx = ADX.calculate({ period: this.ADX_PERIOD, high: highs, low: lows, close: closes });

    const stochRsi = StochasticRSI.calculate({ rsiPeriod: this.STOCH_RSI_PERIOD, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes });

    const macd = MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false, values: closes });

    const volumeSma20 = SMA.calculate({ period: this.VOLUME_PERIOD, values: volumes });

    const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

    // Calculate VWAP
    const vwap = [];
    let cumulativeTypicalPriceVolume = 0;
    let cumulativeVolume = 0;
    for (let i = 0; i < candles.length; i++) {
      const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
      cumulativeTypicalPriceVolume += typicalPrice * volumes[i];
      cumulativeVolume += volumes[i];
      vwap.push(cumulativeTypicalPriceVolume / cumulativeVolume);
    }

    // Align arrays to the end
    const result = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      
      const getVal = (arr: any[], offset: number) => {
        const idx = i - (candles.length - arr.length);
        return idx >= 0 ? arr[idx] : null;
      };

      const bbVal = getVal(bb, 0);
      const adxVal = getVal(adx, 0);
      const stochRsiVal = getVal(stochRsi, 0);
      const macdVal = getVal(macd, 0);

      result.push({
        ...c,
        ema_9: getVal(ema9, 0),
        ema_21: getVal(ema21, 0),
        ema_50: getVal(ema50, 0),
        rsi_14: getVal(rsi14, 0),
        bb_upper: bbVal ? bbVal.upper : null,
        bb_middle: bbVal ? bbVal.middle : null,
        bb_lower: bbVal ? bbVal.lower : null,
        bb_width: bbVal ? (bbVal.upper - bbVal.lower) / bbVal.middle : null,
        vwap: vwap[i],
        adx: adxVal ? adxVal.adx : null,
        adx_plus: adxVal ? adxVal.pdi : null,
        adx_minus: adxVal ? adxVal.mdi : null,
        stoch_rsi_k: stochRsiVal ? stochRsiVal.k : null,
        stoch_rsi_d: stochRsiVal ? stochRsiVal.d : null,
        macd_line: macdVal ? macdVal.MACD : null,
        signal_line: macdVal ? macdVal.signal : null,
        macd_histogram: macdVal ? macdVal.histogram : null,
        volume_sma_20: getVal(volumeSma20, 0),
        volume_ratio: getVal(volumeSma20, 0) ? c.volume / getVal(volumeSma20, 0) : null,
        atr: getVal(atr, 0)
      });
    }

    // Filter out rows with nulls (warmup period)
    return result.filter(r => r.ema_50 !== null && r.adx !== null);
  }
}
