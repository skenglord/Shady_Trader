import { ExchangeConnector } from '../backend/exchange/connector.js';
import { runQuery } from '../backend/database.js';
import { logger } from '../backend/logging/logger.js';

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const TIMEFRAME = '5m';
const CANDLES_PER_BATCH = 500;
const TARGET_CANDLES = 60000;

async function ingestSymbol(connector: ExchangeConnector, symbol: string) {
  const existing = await runQuery<{ count: number }>(
    `SELECT COUNT(*) as count FROM candles WHERE symbol = ? AND timeframe = ?`,
    [symbol, TIMEFRAME]
  );
  const alreadyHave = existing[0]?.count ?? 0;

  if (alreadyHave >= TARGET_CANDLES) {
    logger.info(`[bulk_ingest] ${symbol} already has ${alreadyHave} candles. Skipping.`);
    return;
  }

  logger.info(`[bulk_ingest] ${symbol}: have ${alreadyHave}, targeting ${TARGET_CANDLES}`);

  let inserted = 0;
  let since: number | undefined = undefined;

  while (alreadyHave + inserted < TARGET_CANDLES) {
    const batch = await connector.getCandles(symbol, TIMEFRAME, CANDLES_PER_BATCH, since);
    if (!batch || batch.length === 0) break;

    for (const candle of batch) {
      await runQuery(
        `INSERT OR IGNORE INTO candles
           (symbol, timeframe, time, open, high, low, close, volume)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [symbol, TIMEFRAME, candle.time, candle.open,
         candle.high, candle.low, candle.close, candle.volume]
      );
      inserted++;
    }

    since = batch[0].time - 1;
    logger.info(`[bulk_ingest] ${symbol}: inserted ${inserted} so far...`);

    await new Promise(r => setTimeout(r, 200));
  }

  logger.info(`[bulk_ingest] ${symbol}: complete. Total inserted: ${inserted}`);
}

async function main() {
  const connector = new ExchangeConnector();
  await connector.initialize();

  for (const symbol of SYMBOLS) {
    await ingestSymbol(connector, symbol);
  }

  for (const symbol of SYMBOLS) {
    const result = await runQuery<{ count: number }>(
      `SELECT COUNT(*) as count FROM candles WHERE symbol = ? AND timeframe = ?`,
      [symbol, TIMEFRAME]
    );
    logger.info(`[bulk_ingest] Final count ${symbol}: ${result[0]?.count}`);
  }

  process.exit(0);
}

main().catch(e => { logger.error('[bulk_ingest] Failed', e); process.exit(1); });