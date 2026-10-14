/** Keep raw candles in milliseconds; only chart series use seconds. */
export function mergeLiveCandle(data: any[], candle: any, market: { symbol: string; timeframe: string }) {
  if (!candle || (candle.symbol && candle.symbol !== market.symbol) ||
      (candle.timeframe && candle.timeframe !== market.timeframe)) return null;
  const time = Number(candle.time);
  const values = [candle.open, candle.high, candle.low, candle.close].map(Number);
  if (!Number.isFinite(time) || time <= 0 || !values.every(value => Number.isFinite(value) && value > 0)) return null;
  const last = data.at(-1);
  if (last && time < Number(last.time)) return null;
  const raw = { ...candle, time, open: values[0], high: values[1], low: values[2], close: values[3] };
  if (last && Number(last.time) === time) data[data.length - 1] = { ...last, ...raw };
  else data.push(raw);
  return { time: Math.floor(time / 1000), open: raw.open, high: raw.high, low: raw.low, close: raw.close };
}
