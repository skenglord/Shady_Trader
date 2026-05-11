const { parentPort, workerData } = require('worker_threads');
const { EMA, RSI, BollingerBands, ADX, StochasticRSI, MACD, SMA, ATR } = require('technicalindicators');

const { candles, offset } = workerData;

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const rsi14 = RSI.calculate({ period: 14, values: closes });
  const bb = BollingerBands.calculate({ period: 20, stdDev: 2.0, values: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const stochRsi = StochasticRSI.calculate({ rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes });
  const macd = MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false, values: closes });
  const volumeSma20 = SMA.calculate({ period: 20, values: volumes });
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

  // Align arrays
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    const getVal = (arr, offset) => {
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

  return result;
}

const result = calculateIndicators(candles);
parentPort.postMessage(result);