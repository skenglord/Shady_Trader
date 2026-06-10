import { EMA, RSI, BollingerBands, ADX, MACD, SMA, ATR } from 'technicalindicators';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeVPI } from './volumePressureIndex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── v6.0 Block 3: WaveTrend, MFI, divergence (replace StochRSI) ──

// WaveTrend oscillator. WT1 = signal line, WT2 = trigger line.
// Overbought: wt1 > 60 | Oversold: wt1 < -60
export function calculateWaveTrend(
  hlc3: number[], n1: number = 10, n2: number = 21
): { wt1: number[]; wt2: number[] } {
  const esa = EMA.calculate({ period: n1, values: hlc3 });
  // align esa to hlc3 length
  const esaAligned = alignToEnd(esa, hlc3.length);
  const d = EMA.calculate({ period: n1, values: hlc3.map((v, i) => Math.abs(v - (esaAligned[i] ?? v))) });
  const dAligned = alignToEnd(d, hlc3.length);
  const ci = hlc3.map((v, i) => (v - (esaAligned[i] ?? v)) / (0.015 * (dAligned[i] ?? 1e-9)));
  const wt1raw = EMA.calculate({ period: n2, values: ci });
  const wt1 = alignToEnd(wt1raw, hlc3.length);
  const wt2raw = SMA.calculate({ period: 4, values: wt1.filter(v => v != null) as number[] });
  const wt2 = alignToEnd(wt2raw, hlc3.length);
  return { wt1, wt2 };
}

// Money Flow Index (MFI-14) — volume-weighted RSI. OB: >80 | OS: <20
export function calculateMFI(
  highs: number[], lows: number[], closes: number[], volumes: number[], period: number = 14
): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  for (let i = period; i < closes.length; i++) {
    let posF = 0, negF = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp     = (highs[j] + lows[j] + closes[j]) / 3;
      const tpPrev = j > 0 ? (highs[j-1] + lows[j-1] + closes[j-1]) / 3 : tp;
      const rmf    = tp * volumes[j];
      if (tp > tpPrev) posF += rmf; else if (tp < tpPrev) negF += rmf;
    }
    result[i] = negF === 0 ? 100 : 100 - 100 / (1 + posF / negF);
  }
  return result;
}

// Divergence detection using local extremes (lookback = 5 candles)
export function detectDivergence(
  prices: number[], indicator: number[], lookback: number = 5
): { bullDiv: boolean[]; bearDiv: boolean[] } {
  const bull = new Array(prices.length).fill(false);
  const bear = new Array(prices.length).fill(false);
  for (let i = lookback; i < prices.length; i++) {
    const pw = prices.slice(i - lookback, i + 1);
    const iw = indicator.slice(i - lookback, i + 1).filter(v => isFinite(v));
    if (!iw.length) continue;
    const pMax = Math.max(...pw), pMin = Math.min(...pw);
    const iMax = Math.max(...iw), iMin = Math.min(...iw);
    if (isFinite(indicator[i]) && prices[i] >= pMax * 0.998 && indicator[i] < iMax * 0.99) bear[i] = true;
    if (isFinite(indicator[i]) && prices[i] <= pMin * 1.002 && indicator[i] > iMin * 1.01) bull[i] = true;
  }
  return { bullDiv: bull, bearDiv: bear };
}

// Right-align a shorter indicator array to a full-length series (pad head with null).
function alignToEnd<T>(arr: T[], fullLen: number): (T | null)[] {
  const out: (T | null)[] = new Array(fullLen).fill(null);
  const offset = fullLen - arr.length;
  for (let i = 0; i < arr.length; i++) out[offset + i] = arr[i];
  return out;
}

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
    if (candles.length < 20) {
      return [];
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
      return [];
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

    // ── v6.0: WaveTrend + MFI + divergences (replaces StochRSI) ──
    const hlc3 = candles.map(c => (c.high + c.low + c.close) / 3);
    const { wt1, wt2 } = calculateWaveTrend(hlc3);
    const { bullDiv: wtBullDiv, bearDiv: wtBearDiv } = detectDivergence(closes, wt1.map(v => v ?? NaN));
    const mfiArr = calculateMFI(highs, lows, closes, volumes);
    const { bullDiv: mfiBullDiv, bearDiv: mfiBearDiv } = detectDivergence(closes, mfiArr);

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
      const macdVal = getVal(macd, 0);

      // ── v6.0 indicator values for this candle ──
      const wt1Val = wt1[i] ?? null;
      const wt1Prev = i > 0 ? (wt1[i - 1] ?? null) : null;
      const wt2Val = wt2[i] ?? null;
      const wt2Prev = i > 0 ? (wt2[i - 1] ?? null) : null;
      const mfiVal = isFinite(mfiArr[i]) ? mfiArr[i] : null;
      const volRatioVal = getVal(volumeSma20, 0) ? c.volume / getVal(volumeSma20, 0) : 1;
      const vpi = mfiVal != null
        ? computeVPI(mfiVal, mfiBullDiv[i], mfiBearDiv[i], volRatioVal, c.close, c.open, c.high, c.low).score
        : 0;

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
        // ── v6.0 WaveTrend ──
        wave_trend_1: wt1Val,
        wave_trend_2: wt2Val,
        wt_cross_up: wt1Val != null && wt2Val != null && wt1Prev != null && wt2Prev != null
          ? (wt1Prev <= wt2Prev && wt1Val > wt2Val) : false,
        wt_cross_down: wt1Val != null && wt2Val != null && wt1Prev != null && wt2Prev != null
          ? (wt1Prev >= wt2Prev && wt1Val < wt2Val) : false,
        wt_overbought: wt1Val != null ? wt1Val > 60 : false,
        wt_oversold: wt1Val != null ? wt1Val < -60 : false,
        wt_bull_div: wtBullDiv[i] ?? false,
        wt_bear_div: wtBearDiv[i] ?? false,
        // ── v6.0 MFI + VPI ──
        mfi: mfiVal,
        mfi_overbought: mfiVal != null ? mfiVal > 80 : false,
        mfi_oversold: mfiVal != null ? mfiVal < 20 : false,
        mfi_bull_div: mfiBullDiv[i] ?? false,
        mfi_bear_div: mfiBearDiv[i] ?? false,
        vpi,
        macd_line: macdVal ? macdVal.MACD : null,
        signal_line: macdVal ? macdVal.signal : null,
        macd_histogram: macdVal ? macdVal.histogram : null,
        volume_sma_20: getVal(volumeSma20, 0),
        volume_ratio: getVal(volumeSma20, 0) ? c.volume / getVal(volumeSma20, 0) : null,
        atr: getVal(atr, 0)
      });
    }

    // Filter out rows with nulls (warmup period) — use ema_21 as minimum instead of ema_50
    return result.filter(r => r.ema_9 !== null && r.rsi_14 !== null);
  }
}
