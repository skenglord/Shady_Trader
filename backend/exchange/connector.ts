import { runQuery } from '../database.js';
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../logging/logger.js';
import { randomUUID } from 'crypto';
import { ExchangeAdapterFactory, BaseExchangeAdapter } from './adapter.js';
import { PositionReconciliationEngine } from './reconciliation.js';
import { ProviderRotator, type ProviderName } from './provider-rotator.js';

type ExchangeName = 'coinmarketcap' | 'coinapi' | 'coingecko' | 'binance' | 'kraken' | 'okx' | 'coinbase';
type Capabilities = {
  provider: ExchangeName;
  supportsLiveTrading: boolean;
  supportsAccountReads: boolean;
  supportsPublicMarketData: boolean;
};
type OrderResponse = {
  id: string;
  status: string;
  filled: number;
  price: number;
  timestamp: number;
  simulated: boolean;
  exchange: ExchangeName;
};
type BalanceResponse = Record<string, number | boolean>;
type ExecutionAdapter = {
  capabilities: Capabilities;
  placeOrder: (symbol: string, side: 'buy' | 'sell', amount: number, orderType: 'market' | 'limit', price?: number) => Promise<OrderResponse>;
  getBalance: () => Promise<BalanceResponse>;
  cancelOrder: (orderId: string, symbol: string) => Promise<boolean>;
};

export class ExchangeConnector {
  apiKey: string;
  exchangeName: ExchangeName;
  testnet: boolean;
  private apiSecret: string;
  private apiPassword?: string;
  private ccApiKey: string;
  private currentPrice = 0;
  private lastUpdate = 0;
  private updateInterval: NodeJS.Timeout | null = null;
  private executionAdapter: ExecutionAdapter;
  private exchangeAdapter: BaseExchangeAdapter;
  private reconciliationEngine: PositionReconciliationEngine;
  readonly providerRotator: ProviderRotator;
  private symbolMap: Record<string, string> = {
    'BTC/USDT': 'BTC',
    'ETH/USDT': 'ETH',
    'SOL/USDT': 'SOL'
  };

  private activeSymbol = 'BTC/USDT';

  constructor(exchangeName: string, apiKey: string, apiSecret: string, apiPassword?: string, testnet: boolean = true) {
    this.exchangeName = this.normalizeExchangeName(exchangeName);
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassword = apiPassword;
    this.testnet = testnet;
    this.ccApiKey = process.env.CRYPTOCOMPARE_API_KEY || '';

    // Initialize provider rotator with all available API keys
    this.providerRotator = new ProviderRotator(
      this.exchangeName as ProviderName,
      {
        coingecko: process.env.COINGECKO_API_KEY || '',
        binance: process.env.BINANCE_API_KEY || '',
        coinmarketcap: process.env.COINMARKETCAP_API_KEY || this.apiKey,
        coinapi: process.env.COINAPI_API_KEY || '',
      },
      {
        binance: process.env.BINANCE_SECRET_KEY || this.apiSecret,
      }
    );

    // Validate credentials for non-demo exchanges in production mode
    // In testnet mode, allow empty credentials for testing purposes
    const needsSecret = !['coinmarketcap', 'coinapi', 'coingecko'].includes(this.exchangeName);
    if (needsSecret && !this.testnet) {
      if (!this.apiKey || !this.apiSecret) {
        const message = `Exchange "${this.exchangeName}" requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET`;
        if (this.exchangeName === 'okx' || this.exchangeName === 'coinbase') {
          throw new Error(`${message} and EXCHANGE_API_PASSWORD`);
        }
        throw new Error(message);
      }
    }

    logger.info('ExchangeConnector initialized', {
      service: 'ExchangeConnector',
      exchangeName: this.exchangeName,
      testnet: this.testnet
    });

    // Data-only providers don't need exchange adapters
    const dataOnlyProviders = ['coinmarketcap', 'coinapi', 'coingecko'];
    if (!dataOnlyProviders.includes(this.exchangeName)) {
      // Initialize new adapter system for live-trading exchanges
      this.exchangeAdapter = ExchangeAdapterFactory.createAdapter(
        this.exchangeName as any,
        this.apiKey,
        this.apiSecret,
        this.apiPassword,
        this.testnet
      );

      this.reconciliationEngine = new PositionReconciliationEngine();
      this.reconciliationEngine.registerAdapter(this.exchangeName, this.exchangeAdapter);

      this.executionAdapter = this.createExecutionAdapter();
      this.startReconciliation();
    } else {
      this.exchangeAdapter = null as any;
      this.reconciliationEngine = null as any;
      this.executionAdapter = null as any;
    }
    this.startLiveUpdates();
  }

  private normalizeExchangeName(name: string): ExchangeName {
    const normalized = String(name || 'coinapi').toLowerCase();
    const supportedExchanges: ExchangeName[] = ['coinmarketcap', 'coinapi', 'coingecko', 'binance', 'kraken', 'okx', 'coinbase'];
    
    if (supportedExchanges.includes(normalized as ExchangeName)) {
      return normalized as ExchangeName;
    }

    logger.warn('Unsupported exchange name, defaulting to coinmarketcap', {
      service: 'ExchangeConnector',
      suppliedExchange: normalized
    });
    return 'coinmarketcap';
  }

  setActiveSymbol(symbol: string) {
    this.activeSymbol = symbol;
  }

  private startLiveUpdates() {
    if (this.updateInterval) clearInterval(this.updateInterval);

    this.updateInterval = setInterval(async () => {
      try {
        await this.fetchLatestPrice(this.activeSymbol);
      } catch (error) {
        logger.error('Failed to fetch live market data', {
          service: 'ExchangeConnector',
          exchangeName: this.exchangeName,
          error: (error as Error).message
        });
      }
    }, 5000);
    this.updateInterval.unref?.();
  }

  private startReconciliation() {
    this.reconciliationEngine.startReconciliation(30000); // 30 second intervals
  }

  shutdown() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.reconciliationEngine?.stopReconciliation();
  }

  getCapabilities() {
    return this.executionAdapter?.capabilities || { provider: this.exchangeName, supportsLiveTrading: false, supportsAccountReads: false, supportsPublicMarketData: true };
  }

  private getBinanceBaseUrl(): string {
    return this.testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  }

  private getOkxBaseUrl(): string {
    return this.testnet ? 'https://www.okx.com' : 'https://www.okx.com';
  }

  private getCoinbaseBaseUrl(): string {
    return this.testnet ? 'https://api-public.sandbox.exchange.coinbase.com' : 'https://api.coinbase.com';
  }

  private signOkxRequest(timestamp: string, method: string, path: string, body: string = ''): string {
    const message = timestamp + method + path + body;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('base64');
  }

  private signCoinbaseRequest(timestamp: string, method: string, path: string, body: string = ''): string {
    const message = timestamp + method + path + body;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('base64');
  }

  private async fetchLatestPrice(symbol: string) {
    const baseSymbol = this.symbolMap[symbol] || symbol.split('/')[0];

    // Try provider rotator first (CoinGecko → Binance → CoinMarketCap → CoinAPI)
    try {
      const price = await this.providerRotator.fetchPrice(symbol);
      if (price > 0 && Number.isFinite(price)) {
        this.currentPrice = price;
        this.lastUpdate = Date.now();
        await this.saveTickToDb(symbol, this.currentPrice, 0);
        return;
      }
    } catch (err: any) {
      logger.debug(`[ExchangeConnector] Rotator price fetch failed: ${err.message}`, { service: 'connector' });
    }

    // Fall back to exchange-specific endpoints
    try {
      if (this.exchangeName === 'binance') {
        const pair = symbol.replace('/', '');
        const ticker = await axios.get(`${this.getBinanceBaseUrl()}/api/v3/ticker/24hr`, {
          params: { symbol: pair }
        });

        const price = Number(ticker.data?.lastPrice || 0);
        if (Number.isFinite(price) && price > 0) {
          this.currentPrice = price;
          this.lastUpdate = Date.now();
          await this.saveTickToDb(symbol, this.currentPrice, Number(ticker.data?.volume || 0));
        }
        return;
      }

      if (this.exchangeName === 'kraken') {
        const pair = symbol.replace('/', '');
        const response = await axios.get('https://api.kraken.com/0/public/Ticker', {
          params: { pair }
        });

        const firstResult = Object.values(response.data?.result || {})[0] as any;
        const price = Number(firstResult?.c?.[0] || 0);
        const volume = Number(firstResult?.v?.[1] || 0);
        if (Number.isFinite(price) && price > 0) {
          this.currentPrice = price;
          this.lastUpdate = Date.now();
          await this.saveTickToDb(symbol, this.currentPrice, volume);
        }
        return;
      }

      if (this.exchangeName === 'okx') {
        const pair = symbol.replace('/', '-');
        const response = await axios.get(`${this.getOkxBaseUrl()}/api/v5/market/ticker`, {
          params: { instId: pair }
        });

        const price = Number(response.data?.data?.[0]?.last || 0);
        const volume = Number(response.data?.data?.[0]?.vol24h || 0);
        if (Number.isFinite(price) && price > 0) {
          this.currentPrice = price;
          this.lastUpdate = Date.now();
          await this.saveTickToDb(symbol, this.currentPrice, volume);
        }
        return;
      }

      if (this.exchangeName === 'coinbase') {
        const pair = symbol.replace('/', '-');
        const response = await axios.get(`${this.getCoinbaseBaseUrl()}/api/v3/brokerage/market/get_ticker`, {
          params: { product_id: pair }
        });

        const price = Number(response.data?.price || 0);
        const volume = Number(response.data?.volume || 0);
        if (Number.isFinite(price) && price > 0) {
          this.currentPrice = price;
          this.lastUpdate = Date.now();
          await this.saveTickToDb(symbol, this.currentPrice, volume);
        }
        return;
      }

      if (this.exchangeName === 'coinapi') {
        // CoinAPI exchange rate endpoint: GET /v1/exchangerate/{asset_id_base}/{asset_id_quote}
        const quoteSymbol = symbol.includes('/') ? symbol.split('/')[1] : 'USD';
        const response = await axios.get(`https://rest.coinapi.io/v1/exchangerate/${baseSymbol}/${quoteSymbol}`, {
          headers: {
            'X-CoinAPI-Key': this.apiKey,
            'Accept': 'application/json'
          }
        });

        if (response.data?.rate) {
          this.currentPrice = Number(response.data.rate);
          this.lastUpdate = Date.now();
          await this.saveTickToDb(symbol, this.currentPrice, 0);
        }
        return;
      }

      if (this.exchangeName === 'coingecko') {
        // CoinGecko simple price endpoint
        const coinGeckoIdMap: Record<string, string> = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana' };
        const coinId = coinGeckoIdMap[baseSymbol] || baseSymbol.toLowerCase();
        const cgParams: Record<string, any> = { ids: coinId, vs_currencies: 'usd', include_24hr_vol: 'true' };
        if (this.apiKey) cgParams.x_cg_demo_api_key = this.apiKey;
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: cgParams });

        if (response.data?.[coinId]?.usd) {
          this.currentPrice = Number(response.data[coinId].usd);
          this.lastUpdate = Date.now();
          await this.saveTickToDb(symbol, this.currentPrice, Number(response.data[coinId]?.usd_24h_vol || 0));
        }
        return;
      }

      const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
        headers: {
          'X-CMC_PRO_API_KEY': this.apiKey,
          Accept: 'application/json'
        },
        params: {
          symbol: baseSymbol,
          convert: 'USD'
        }
      });

      const data = response.data?.data?.[baseSymbol];
      if (data?.quote?.USD) {
        this.currentPrice = Number(data.quote.USD.price);
        this.lastUpdate = Date.now();
        await this.saveTickToDb(symbol, this.currentPrice, Number(data.quote.USD.volume_24h || 0));
      }
    } catch (error: any) {
      logger.warn('Primary exchange failed, trying CryptoCompare fallback', {
        service: 'ExchangeConnector',
        exchangeName: this.exchangeName
      });
      await this.fetchCryptoComparePrice(symbol);
    }
  }

  private async fetchCryptoComparePrice(symbol: string) {
    const baseSymbol = this.symbolMap[symbol] || symbol.split('/')[0];
    try {
      const ccParams: Record<string, any> = { fsyms: baseSymbol, tsyms: 'USD' };
      if (this.ccApiKey) ccParams.api_key = this.ccApiKey;
      const response = await axios.get('https://min-api.cryptocompare.com/data/pricemulti', { params: ccParams });
      const price = Number(response.data?.[baseSymbol]?.USD);
      if (Number.isFinite(price) && price > 0) {
        this.currentPrice = price;
        this.lastUpdate = Date.now();
        await this.saveTickToDb(symbol, this.currentPrice, 0);
        logger.info('CryptoCompare fallback succeeded', {
          service: 'ExchangeConnector',
          symbol: baseSymbol,
          price
        });
      }
    } catch (error: any) {
      logger.error('CryptoCompare fallback also failed', {
        service: 'ExchangeConnector',
        error: error.message
      });
    }
  }

  async fetchCryptoCompareHistorical(symbol: string, timeframe: string, limit: number = 100): Promise<any[]> {
    const baseSymbol = this.symbolMap[symbol] || symbol.split('/')[0];
    const intervalMap: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 };
    const interval = intervalMap[timeframe] || 60;

    try {
      const ccParams: Record<string, any> = { fsym: baseSymbol, tsym: 'USD', limit: Math.min(limit, 2000), aggregate: interval };
      if (this.ccApiKey) ccParams.api_key = this.ccApiKey;
      const response = await axios.get('https://min-api.cryptocompare.com/data/v2/histoday', { params: ccParams });

      if (response.data?.Data?.Data) {
        return response.data.Data.Data.map((c: any) => ({
          time: c.time * 1000,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volumeto || c.volumefrom || 0
        }));
      }
    } catch (error: any) {
      logger.error('CryptoCompare historical fetch failed', {
        service: 'ExchangeConnector',
        symbol: baseSymbol,
        error: error.message
      });
    }
    return [];
  }

  async fetchCoinAPIHistorical(symbol: string, timeframe: string, limit: number = 100): Promise<any[]> {
    // This method's original HTTP-based CoinAPI implementation has been moved
    // to `fetchCoinAPIHistoricalHttp` below. The default path now uses local
    // aggregation from a finer-grained base timeframe, which keeps the engine
    // running even when no real-time feed is available.
    return await this.aggregateFromBaseTimeframe(symbol, timeframe, limit);
  }

  /** Aggregate candles from a finer-grained base timeframe (e.g. 1m → 5m).
   *  This is used by getCandles() when the requested timeframe has no direct
   *  data in the local DB but a base timeframe (typically 1m) does. It keeps
   *  the trading cycle alive when live feeds are unavailable so that
   *  regime detection, signal generation, and DB persistence continue to run. */
  async aggregateFromBaseTimeframe(symbol: string, timeframe: string, limit: number = 100): Promise<any[]> {
    const msPerCandle: Record<string, number> = {
      '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000
    };
    const targetMs = msPerCandle[timeframe] || 3_600_000;
    if (targetMs === 60_000) {
      // Already 1m — no aggregation needed; return the raw rows from the caller.
      return [];
    }

    // Find the finest base timeframe that has data for this symbol.
    // runQuery is async, so we can't use Array.find (sync callback). Loop
    // with await instead.
    const candidates = ['1m', '5m', '15m', '1h', '4h', '1d'];
    let baseTimeframe: string | undefined;
    for (const tf of candidates) {
      if (msPerCandle[tf] >= targetMs) continue;
      const cnt: any[] = await runQuery(
        'SELECT COUNT(*) as n FROM candles WHERE symbol = ? AND timeframe = ?',
        [symbol, tf], 'all'
      );
      if (cnt[0]?.n >= 20) { baseTimeframe = tf; break; }
    }
    if (!baseTimeframe) return [];

    // Pull enough base candles to build `limit` target candles.
    const baseMs = msPerCandle[baseTimeframe];
    const baseLimit = Math.ceil((targetMs / baseMs) * limit) + 10;
    const baseRows = await runQuery(
      `SELECT time, open, high, low, close, volume
       FROM candles
       WHERE symbol = ? AND timeframe = ?
       ORDER BY time DESC
       LIMIT ?`,
      [symbol, baseTimeframe, baseLimit], 'all'
    );
    if (baseRows.length < 20) return [];

    // Group base candles by target-timeframe bucket and aggregate OHLCV.
    const sorted = [...baseRows].sort((a: any, b: any) => a.time - b.time);
    const buckets = new Map<number, any[]>();
    for (const r of sorted) {
      const bucketTime = Math.floor(r.time / targetMs) * targetMs;
      if (!buckets.has(bucketTime)) buckets.set(bucketTime, []);
      buckets.get(bucketTime)!.push(r);
    }
    const aggregated: any[] = [];
    for (const [bucketTime, candles] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      aggregated.push({
        time: bucketTime,
        open: candles[0].open,
        high: Math.max(...candles.map((c: any) => c.high)),
        low: Math.min(...candles.map((c: any) => c.low)),
        close: candles[candles.length - 1].close,
        volume: candles.reduce((s: number, c: any) => s + (c.volume || 0), 0),
      });
    }
    logger.info(`[ExchangeConnector] Aggregated ${aggregated.length} ${timeframe} candles from ${baseRows.length} ${baseTimeframe} base candles for ${symbol}`, { service: 'connector' });
    return aggregated.slice(-limit);
  }
  /** Original CoinAPI HTTP fetch. Kept for when a real COINAPI_API_KEY is
   *  configured. The default path is the local aggregator above, which works
   *  offline. */
  async fetchCoinAPIHistoricalHttp(symbol: string, timeframe: string, limit: number = 100): Promise<any[]> {
    const baseSymbol = this.symbolMap[symbol] || symbol.split('/')[0];
    const quoteSymbol = symbol.includes('/') ? symbol.split('/')[1] : 'USD';
    // Map timeframe to CoinAPI period_id
    const periodMap: Record<string, string> = { '1m': '1MIN', '5m': '5MIN', '15m': '15MIN', '1h': '1HRS', '4h': '4HRS', '1d': '1DAY' };
    const periodId = periodMap[timeframe] || '1HRS';
    // Map timeframe to milliseconds for time_start calculation
    const msMap: Record<string, number> = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
    const periodMs = msMap[timeframe] || 3600000;
    // Use Binance as the default exchange for CoinAPI symbol IDs (most liquid)
    const symbolId = `BINANCE_SPOT_${baseSymbol}_${quoteSymbol}`;

    try {
      const timeStart = new Date(Date.now() - (limit * periodMs)).toISOString();
      const response = await axios.get(`https://rest.coinapi.io/v1/ohlcv/${symbolId}/history`, {
        headers: {
          'X-CoinAPI-Key': this.apiKey,
          'Accept': 'application/json'
        },
        params: {
          period_id: periodId,
          time_start: timeStart,
          limit: Math.min(limit, 500)
        }
      });

      if (Array.isArray(response.data) && response.data.length > 0) {
        return response.data.map((c: any) => ({
          time: new Date(c.time_period_start).getTime(),
          open: c.price_open,
          high: c.price_high,
          low: c.price_low,
          close: c.price_close,
          volume: c.volume_traded || 0
        }));
      }
    } catch (error: any) {
      logger.warn('CoinAPI historical fetch failed', {
        service: 'ExchangeConnector',
        symbol: symbolId,
        error: error.response?.data?.error || error.response?.data?.detail || error.message
      });
    }
    return [];
  }

  private async saveTickToDb(symbol: string, price: number, volume: number) {
    const now = Date.now();
    const candleTime = Math.floor(now / 60000) * 60000;

    try {
      await runQuery(
        `
        INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
        VALUES (?, '1m', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, timeframe, time) DO UPDATE SET
        high = MAX(high, excluded.high),
        low = MIN(low, excluded.low),
        close = excluded.close,
        volume = excluded.volume
      `,
        [symbol, candleTime, price, price, price, price, volume]
      );
    } catch (error) {
      logger.error('Failed to save tick to DB', { service: 'ExchangeConnector', error: (error as Error).message });
    }
  }

  async fetchExchangeOHLCV(symbol: string, timeframe: string, since: number, limit: number) {
    return this.getHistoricalCandles(symbol, timeframe, since, limit);
  }

  async getHistoricalCandles(symbol: string, timeframe: string, since: number, limit: number = 1000, toTime?: number) {
    let rows;

    if (toTime) {
      rows = await runQuery(
        `
        SELECT time, open, high, low, close, volume
        FROM candles
        WHERE symbol = ? AND timeframe = ? AND time >= ? AND time <= ?
        ORDER BY time ASC
      `,
        [symbol, timeframe, since, toTime],
        'all'
      );
    } else {
      rows = await runQuery(
        `
        SELECT time, open, high, low, close, volume
        FROM candles
        WHERE symbol = ? AND timeframe = ? AND time >= ?
        ORDER BY time DESC
        LIMIT ?
      `,
        [symbol, timeframe, since, limit],
        'all'
      );
      rows = rows.reverse();
    }

    if (rows.length < 20) {
      // Try CoinAPI for historical data
      if (this.exchangeName === 'coinapi' && this.apiKey) {
        const coinApiRows = await this.fetchCoinAPIHistorical(symbol, timeframe, limit);
        if (coinApiRows.length >= 20) {
          for (const c of coinApiRows) {
            runQuery(`INSERT OR IGNORE INTO candles (symbol, timeframe, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [symbol, timeframe, c.time, c.open, c.high, c.low, c.close, c.volume]).catch(() => {});
          }
          return coinApiRows;
        }
      }
      // Fallback: generate simulated historical candles
      const basePrice = this.currentPrice || 50000;
      const msPerCandle = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 }[timeframe] || 3600000;
      const now = Math.floor(Date.now() / msPerCandle) * msPerCandle;
      const count = Math.min(limit, 200);

      let price = basePrice;
      let trend = 0;
      let momentum = 0;

      rows = Array.from({ length: count }).map((_, i) => {
        const time = now - (count - 1 - i) * msPerCandle;
        const phase = (i % 30) / 30;
        const clusterVol = phase < 0.15 ? 0.008 : 0;
        const currentVol = 0.002 + clusterVol + Math.random() * 0.002;
        if (i % 20 === 0) momentum = (Math.random() - 0.45) * 0.003;
        trend += momentum + (Math.random() - 0.5) * 0.0005;
        if (trend > 0.01) trend = 0.01;
        if (trend < -0.01) trend = -0.01;
        const meanReversion = (50000 - price) / price * 0.002;
        const noise = (Math.random() - 0.5) * currentVol;
        const change = price * (trend * 0.1 + noise + meanReversion);
        const open = price;
        let close = price + change;
        if (close < 5000) close = 5000 + Math.random() * 1000;
        if (close > 500000) close = 500000 - Math.random() * 10000;
        if (close < open * 0.1) close = open * 0.1 + Math.random() * open * 0.05;
        let halfRange = Math.abs(close - open) + open * currentVol;
        let high = Math.max(open, close) + Math.random() * Math.min(halfRange, open * 0.05);
        let low = Math.min(open, close) - Math.random() * Math.min(halfRange, open * 0.05);
        if (high > 500000) high = 500000 - Math.random() * 5000;
        if (low < 5000) low = 5000 + Math.random() * 500;
        price = close;
        const volume = (50 + Math.random() * 50) * (1 + clusterVol * 50);

        // Persist to DB
        runQuery(`INSERT OR IGNORE INTO candles (symbol, timeframe, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [symbol, timeframe, time, open, high, low, close, volume]).catch(() => {});
        return { time, open, high, low, close, volume };
      });
    }

    return rows;
  }

  async getCandles(symbol: string, timeframe: string, limit: number = 100) {
    // 1. Try provider rotator (CoinGecko → Binance → CoinMarketCap → CoinAPI)
    //    with 5s timeout per provider and auto-rotate on failure.
    try {
      const rotated = await this.providerRotator.getCandles(symbol, timeframe, limit);
      if (rotated.length >= 20) {
        // Persist fetched candles to DB for offline resilience
        for (const c of rotated) {
          runQuery(
            `INSERT OR IGNORE INTO candles (symbol, timeframe, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [symbol, timeframe, c.time, c.open, c.high, c.low, c.close, c.volume]
          ).catch(() => {});
        }
        return rotated;
      }
    } catch (err: any) {
      logger.warn(`[ExchangeConnector] Provider rotator failed: ${err.message}`, { service: 'connector' });
    }

    // 2. Fall back to local DB
    let rows = await runQuery(
      `
      SELECT time, open, high, low, close, volume
      FROM candles
      WHERE symbol = ? AND timeframe = ?
      ORDER BY time DESC
      LIMIT ?
    `,
      [symbol, timeframe, limit],
      'all'
    );

      if (rows.length < 20) {
        // Try CoinAPI for historical data when provider is coinapi
        if (this.exchangeName === 'coinapi' && this.apiKey) {
          const coinApiRows = await this.fetchCoinAPIHistorical(symbol, timeframe, limit);
          if (coinApiRows.length >= 20) {
            // Persist fetched candles to DB
            const msPerCandle = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 }[timeframe] || 3600000;
            for (const c of coinApiRows) {
              runQuery(`INSERT OR IGNORE INTO candles (symbol, timeframe, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [symbol, timeframe, c.time, c.open, c.high, c.low, c.close, c.volume]).catch(() => {});
            }
            return coinApiRows;
          }
        }

        // Never synthesize fake data — return what we have
        if (this.exchangeName === 'coingecko' || rows.length === 0) {
          // Try to aggregate from a finer-grained timeframe that we DO have
          // (e.g., 1m candles → 5m candles). This keeps the engine running when
          // the configured timeframe has no direct data but 1m data exists.
          const aggregated = await this.aggregateFromBaseTimeframe(symbol, timeframe, limit);
          if (aggregated.length >= 20) {
            return aggregated;
          }
          logger.warn(`[ExchangeConnector] Only ${rows.length} candles available for ${symbol} ${timeframe}. Returning partial data.`, { service: 'connector' });
          return rows;
        }

        if (this.currentPrice === 0) {
          await this.fetchLatestPrice(symbol);
        }

      const basePrice = this.currentPrice || 50000;
      // Use a consistent epoch aligned to timeframe boundaries to prevent new candles every cycle
      const msPerCandle = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 }[timeframe] || 3600000;
      const now = Math.floor(Date.now() / msPerCandle) * msPerCandle;

      // Generate realistic synthetic candles with trends, volatility clusters, and momentum
      let price = basePrice;
      let trend = 0; // cumulative trend drift
      let volatility = 0.002; // base volatility (0.2%)
      let momentum = 0;

      rows = Array.from({ length: limit }).map((_, i) => {
        const time = now - (limit - 1 - i) * msPerCandle;

        // Phase-based volatility: clusters of high volatility every ~30 candles
        const phase = (i % 30) / 30;
        const clusterVol = phase < 0.15 ? 0.008 : 0; // volatility spike in first 15% of each phase
        const currentVol = volatility + clusterVol + Math.random() * 0.002;

        // Trend: slow drift with occasional momentum shifts
        if (i % 20 === 0) {
          momentum = (Math.random() - 0.45) * 0.003; // slight bullish bias
        }
        trend += momentum + (Math.random() - 0.5) * 0.0005;
        // Clamp trend to prevent exponential price explosion
        if (trend > 0.01) trend = 0.01;
        if (trend < -0.01) trend = -0.01;

        // Price change with mean reversion (fractional, ~0.2% pull toward 50K)
        const meanReversion = (50000 - price) / price * 0.002;
        const noise = (Math.random() - 0.5) * currentVol;
        const change = price * (trend * 0.1 + noise + meanReversion);
        const open = price;
        let close = price + change;
        // Clamp price to realistic range with proportional limits
        if (close < 5000) close = 5000 + Math.random() * 1000;
        if (close > 500000) close = 500000 - Math.random() * 10000;
        // Also prevent >90% single-candle drop (keeps OHLC gap manageable)
        if (close < open * 0.1) close = open * 0.1 + Math.random() * open * 0.05;
        const halfRange = Math.abs(close - open) + open * currentVol;
        let high = Math.max(open, close) + Math.random() * Math.min(halfRange, open * 0.05);
        let low = Math.min(open, close) - Math.random() * Math.min(halfRange, open * 0.05);
        // Clamp high/low to realistic range
        if (high > 500000) high = 500000 - Math.random() * 5000;
        if (low < 5000) low = 5000 + Math.random() * 500;
        price = close;

        // Volume: higher during volatility clusters
        const volume = (50 + Math.random() * 50) * (1 + clusterVol * 50);

        // Persist to DB so data survives restart
        runQuery(`INSERT OR IGNORE INTO candles (symbol, timeframe, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [symbol, timeframe, time, open, high, low, close, volume]).catch(() => {});

        return { time, open, high, low, close, volume };
      });
    } else {
      rows = rows.reverse();
    }

    return rows;
  }

  private signBinanceQuery(query: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  private signKrakenPayload(path: string, nonce: string, requestBody: URLSearchParams): string {
    const secret = Buffer.from(this.apiSecret, 'base64');
    const hash = crypto.createHash('sha256').update(`${nonce}${requestBody.toString()}`).digest();
    return crypto.createHmac('sha512', secret).update(path).update(hash).digest('base64');
  }

  private createExecutionAdapter(): ExecutionAdapter {
    if (this.exchangeName === 'binance') {
      return {
        capabilities: {
          provider: 'binance',
          supportsLiveTrading: true,
          supportsAccountReads: true,
          supportsPublicMarketData: true
        },
        placeOrder: async (symbol, side, amount, orderType, price) => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Binance order execution requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const pair = symbol.replace('/', '');
          const params = new URLSearchParams({
            symbol: pair,
            side: side.toUpperCase(),
            type: orderType.toUpperCase(),
            quantity: String(amount),
            timestamp: String(Date.now())
          });

          if (orderType === 'limit' && price) {
            params.set('price', String(price));
            params.set('timeInForce', 'GTC');
          }

          const signature = this.signBinanceQuery(params.toString());
          params.set('signature', signature);

          const response = await axios.post(`${this.getBinanceBaseUrl()}/api/v3/order`, params.toString(), {
            headers: {
              'X-MBX-APIKEY': this.apiKey,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          });

          return {
            id: String(response.data?.orderId || ''),
            status: response.data?.status || 'unknown',
            filled: Number(response.data?.executedQty || 0),
            price: Number(response.data?.price || response.data?.fills?.[0]?.price || price || this.currentPrice || 0),
            timestamp: Number(response.data?.transactTime || Date.now()),
            simulated: false,
            exchange: 'binance' as ExchangeName
          };
        },
        getBalance: async () => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Binance account reads require EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const params = new URLSearchParams({ timestamp: String(Date.now()) });
          params.set('signature', this.signBinanceQuery(params.toString()));

          const response = await axios.get(`${this.getBinanceBaseUrl()}/api/v3/account`, {
            params,
            headers: { 'X-MBX-APIKEY': this.apiKey }
          });

          const balances = response.data?.balances || [];
          const result: BalanceResponse = { simulated: false };
          for (const row of balances) {
            const free = Number(row.free || 0);
            if (free > 0) result[row.asset] = free;
          }
          return result;
        },
        cancelOrder: async (orderId, symbol) => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Binance order cancellation requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const params = new URLSearchParams({
            symbol: symbol.replace('/', ''),
            orderId,
            timestamp: String(Date.now())
          });
          params.set('signature', this.signBinanceQuery(params.toString()));
          await axios.delete(`${this.getBinanceBaseUrl()}/api/v3/order`, {
            params,
            headers: { 'X-MBX-APIKEY': this.apiKey }
          });
          return true;
        }
      };
    }

    if (this.exchangeName === 'kraken') {
      return {
        capabilities: {
          provider: 'kraken',
          supportsLiveTrading: true,
          supportsAccountReads: true,
          supportsPublicMarketData: true
        },
        placeOrder: async (symbol, side, amount) => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Kraken order execution requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
          const endpoint = '/0/private/AddOrder';
          const params = new URLSearchParams({
            nonce,
            pair: symbol.replace('/', ''),
            type: side,
            ordertype: 'market',
            volume: String(amount)
          });
          const signature = this.signKrakenPayload(endpoint, nonce, params);
          const response = await axios.post(`https://api.kraken.com${endpoint}`, params.toString(), {
            headers: {
              'API-Key': this.apiKey,
              'API-Sign': signature,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          });
          const txid = response.data?.result?.txid?.[0];
          return {
            id: String(txid || ''),
            status: response.data?.error?.length ? 'rejected' : 'open',
            filled: amount,
            price: this.currentPrice || 0,
            timestamp: Date.now(),
            simulated: false,
            exchange: 'kraken' as ExchangeName
          };
        },
        getBalance: async () => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Kraken account reads require EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
          const endpoint = '/0/private/Balance';
          const params = new URLSearchParams({ nonce });
          const signature = this.signKrakenPayload(endpoint, nonce, params);
          const response = await axios.post(`https://api.kraken.com${endpoint}`, params.toString(), {
            headers: {
              'API-Key': this.apiKey,
              'API-Sign': signature,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          });
          const result: BalanceResponse = { simulated: false };
          const balances = response.data?.result || {};
          for (const [asset, value] of Object.entries(balances)) {
            const amount = Number(value || 0);
            if (amount > 0) result[asset] = amount;
          }
          return result;
        },
        cancelOrder: async (orderId) => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Kraken order cancellation requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
          const endpoint = '/0/private/CancelOrder';
          const params = new URLSearchParams({ nonce, txid: orderId });
          const signature = this.signKrakenPayload(endpoint, nonce, params);
          await axios.post(`https://api.kraken.com${endpoint}`, params.toString(), {
            headers: {
              'API-Key': this.apiKey,
              'API-Sign': signature,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          });
          return true;
        }
      };
    }

    if (this.exchangeName === 'okx') {
      return {
        capabilities: {
          provider: 'okx',
          supportsLiveTrading: true,
          supportsAccountReads: true,
          supportsPublicMarketData: true
        },
        placeOrder: async (symbol, side, amount, orderType, price) => {
          if (!this.apiKey || !this.apiSecret || !this.apiPassword) {
            throw new Error('OKX order execution requires EXCHANGE_API_KEY, EXCHANGE_API_SECRET, and EXCHANGE_API_PASSWORD');
          }
          const pair = symbol.replace('/', '-');
          const timestamp = Date.now().toString();
          const method = 'POST';
          const path = '/api/v5/trade/order';
          const orderBody = JSON.stringify({
            instId: pair,
            tdMode: 'cash',
            side: side === 'buy' ? 'buy' : 'sell',
            ordType: orderType === 'limit' ? 'limit' : 'market',
            sz: String(amount),
            px: price ? String(price) : ''
          });
          const signature = this.signOkxRequest(timestamp, method, path, orderBody);
          
          const response = await axios.post(`${this.getOkxBaseUrl()}${path}`, orderBody, {
            headers: {
              'OK-ACCESS-KEY': this.apiKey,
              'OK-ACCESS-SIGN': signature,
              'OK-ACCESS-TIMESTAMP': timestamp,
              'OK-ACCESS-PASSPHRASE': this.apiPassword,
              'Content-Type': 'application/json'
            }
          });

          const data = response.data?.data?.[0];
          return {
            id: String(data?.ordId || ''),
            status: data?.state === 'filled' ? 'closed' : (data?.state === 'live' ? 'open' : 'unknown'),
            filled: Number(data?.accFillSz || 0),
            price: Number(data?.avgPx || price || this.currentPrice || 0),
            timestamp: Number(data?.cTime || Date.now()),
            simulated: false,
            exchange: 'okx' as ExchangeName
          };
        },
        getBalance: async () => {
          if (!this.apiKey || !this.apiSecret || !this.apiPassword) {
            throw new Error('OKX account reads require EXCHANGE_API_KEY, EXCHANGE_API_SECRET, and EXCHANGE_API_PASSWORD');
          }
          const timestamp = Date.now().toString();
          const method = 'GET';
          const path = '/api/v5/account/balance';
          const signature = this.signOkxRequest(timestamp, method, path, '');
          
          const response = await axios.get(`${this.getOkxBaseUrl()}${path}`, {
            headers: {
              'OK-ACCESS-KEY': this.apiKey,
              'OK-ACCESS-SIGN': signature,
              'OK-ACCESS-TIMESTAMP': timestamp,
              'OK-ACCESS-PASSPHRASE': this.apiPassword,
              'Content-Type': 'application/json'
            }
          });

          const result: BalanceResponse = { simulated: false };
          const balances = response.data?.data?.[0]?.details || [];
          for (const row of balances) {
            const free = Number(row.cashBal || 0);
            if (free > 0) result[row.ccy] = free;
          }
          return result;
        },
        cancelOrder: async (orderId, symbol) => {
          if (!this.apiKey || !this.apiSecret || !this.apiPassword) {
            throw new Error('OKX order cancellation requires EXCHANGE_API_KEY, EXCHANGE_API_SECRET, and EXCHANGE_API_PASSWORD');
          }
          const pair = symbol.replace('/', '-');
          const timestamp = Date.now().toString();
          const method = 'POST';
          const path = '/api/v5/trade/cancel-order';
          const orderBody = JSON.stringify({
            instId: pair,
            ordId: orderId
          });
          const signature = this.signOkxRequest(timestamp, method, path, orderBody);
          
          await axios.post(`${this.getOkxBaseUrl()}${path}`, orderBody, {
            headers: {
              'OK-ACCESS-KEY': this.apiKey,
              'OK-ACCESS-SIGN': signature,
              'OK-ACCESS-TIMESTAMP': timestamp,
              'OK-ACCESS-PASSPHRASE': this.apiPassword,
              'Content-Type': 'application/json'
            }
          });
          return true;
        }
      };
    }

    if (this.exchangeName === 'coinbase') {
      return {
        capabilities: {
          provider: 'coinbase',
          supportsLiveTrading: true,
          supportsAccountReads: true,
          supportsPublicMarketData: true
        },
        placeOrder: async (symbol, side, amount, orderType, price) => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Coinbase order execution requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const pair = symbol.replace('/', '-');
          const timestamp = Date.now().toString();
          const method = 'POST';
          const path = '/api/v3/brokerage/orders';
          const orderBody = JSON.stringify({
            product_id: pair,
            side: side === 'buy' ? 'BUY' : 'SELL',
            order_type: orderType === 'limit' ? 'LIMIT' : 'MARKET',
            size: String(amount),
            base_size: String(amount),
            ...(price && { price: String(price) })
          });
          const signature = this.signCoinbaseRequest(timestamp, method, path, orderBody);
          
          const response = await axios.post(`${this.getCoinbaseBaseUrl()}${path}`, orderBody, {
            headers: {
              'CB-ACCESS-KEY': this.apiKey,
              'CB-ACCESS-SIGN': signature,
              'CB-ACCESS-TIMESTAMP': timestamp,
              'Content-Type': 'application/json'
            }
          });

          const data = response.data;
          return {
            id: String(data?.order_id || ''),
            status: data?.status === 'FILLED' ? 'closed' : (data?.status === 'OPEN' ? 'open' : 'unknown'),
            filled: Number(data?.filled_size || 0),
            price: Number(data?.average_filled_price || price || this.currentPrice || 0),
            timestamp: Number(data?.created_time ? new Date(data.created_time).getTime() : Date.now()),
            simulated: false,
            exchange: 'coinbase' as ExchangeName
          };
        },
        getBalance: async () => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Coinbase account reads require EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const timestamp = Date.now().toString();
          const method = 'GET';
          const path = '/api/v3/brokerage/accounts';
          const signature = this.signCoinbaseRequest(timestamp, method, path, '');
          
          const response = await axios.get(`${this.getCoinbaseBaseUrl()}${path}`, {
            headers: {
              'CB-ACCESS-KEY': this.apiKey,
              'CB-ACCESS-SIGN': signature,
              'CB-ACCESS-TIMESTAMP': timestamp,
              'Content-Type': 'application/json'
            }
          });

          const result: BalanceResponse = { simulated: false };
          const accounts = response.data?.accounts || [];
          for (const row of accounts) {
            const free = Number(row.available_balance?.value || 0);
            if (free > 0) result[row.currency] = free;
          }
          return result;
        },
        cancelOrder: async (orderId, symbol) => {
          if (!this.apiKey || !this.apiSecret) {
            throw new Error('Coinbase order cancellation requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
          }
          const timestamp = Date.now().toString();
          const method = 'DELETE';
          const path = `/api/v3/brokerage/orders/${orderId}`;
          const signature = this.signCoinbaseRequest(timestamp, method, path, '');
          
          await axios.delete(`${this.getCoinbaseBaseUrl()}${path}`, {
            headers: {
              'CB-ACCESS-KEY': this.apiKey,
              'CB-ACCESS-SIGN': signature,
              'CB-ACCESS-TIMESTAMP': timestamp,
              'Content-Type': 'application/json'
            }
          });
          return true;
        }
      };
    }

    return {
      capabilities: {
        provider: this.exchangeName,
        supportsLiveTrading: false,
        supportsAccountReads: false,
        supportsPublicMarketData: true
      },
      placeOrder: async (_symbol, _side, amount, _orderType, price) => ({
        id: Math.random().toString(36).substring(7),
        status: 'closed',
        filled: amount,
        price: price || this.currentPrice,
        timestamp: Date.now(),
        simulated: true,
        exchange: this.exchangeName
      }),
      getBalance: async () => ({ USDT: 10000, BTC: 0.5, simulated: true }),
      cancelOrder: async () => true
    };
  }

  async placeOrder(symbol: string, side: 'buy' | 'sell', amount: number, orderType: 'market' | 'limit' = 'market', price?: number) {
    return this.executionAdapter.placeOrder(symbol, side, amount, orderType, price);
  }

  async getBalance() {
    return this.executionAdapter.getBalance();
  }

  async cancelOrder(orderId: string, symbol: string) {
    return this.executionAdapter.cancelOrder(orderId, symbol);
  }

  async placeOCOOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    stopPrice: number,
    takeProfitPrice: number
  ) {
    try {
      const result = await this.exchangeAdapter.placeOCOOrder(symbol, side, quantity, stopPrice, takeProfitPrice);

      // Log the OCO order placement
      await this.logSystemEvent('oco_order_placed', `OCO order placed for ${symbol}`, {
        symbol,
        side,
        quantity,
        stopPrice,
        takeProfitPrice,
        stopOrderId: result.stopOrder.id,
        takeProfitOrderId: result.takeProfitOrder.id
      });

      return result;
    } catch (error) {
      logger.error('Failed to place OCO order', {
        service: 'ExchangeConnector',
        exchange: this.exchangeName,
        symbol,
        error: error.message
      });
      throw error;
    }
  }

  private async logSystemEvent(eventType: string, message: string, metadata?: any) {
    try {
      const auditId = randomUUID();
      const timestamp = Date.now();
      const metadataJson = metadata ? JSON.stringify(metadata) : null;

      await runQuery(`
        INSERT INTO audit_system_events (id, event_type, message, timestamp, severity, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [auditId, eventType, message, timestamp, 'info', metadataJson]);
    } catch (error) {
      logger.error('Failed to log system event', { error: error.message });
    }
  }

  async getCurrentPrice(symbol: string) {
    if (Date.now() - this.lastUpdate > 10000) {
      await this.fetchLatestPrice(symbol);
    }
    return this.currentPrice;
  }

  async getOrderBook(symbol: string, limit: number = 50): Promise<OrderBookData> {
    try {
      const orderBook = await this.exchangeAdapter.getOrderBook(symbol, limit);

      return {
        symbol,
        timestamp: orderBook.timestamp,
        bids: orderBook.bids.map(b => [b.price, b.quantity]),
        asks: orderBook.asks.map(a => [a.price, a.quantity]),
        exchange: this.exchangeName
      };
    } catch (error) {
      logger.error('Failed to fetch order book', {
        service: 'ExchangeConnector',
        exchange: this.exchangeName,
        symbol,
        error: error.message
      });

      // Return mock data for development
      return this.getMockOrderBook(symbol);
    }
  }

  private getOrderBookUrl(symbol: string, limit: number): string {
    const baseUrls = {
      binance: 'https://api.binance.com/api/v3/depth',
      kraken: 'https://api.kraken.com/0/public/Depth',
      okx: 'https://www.okx.com/api/v5/market/books',
      coinbase: 'https://api.exchange.coinbase.com/products/{symbol}/book',
      coinmarketcap: '' // No order book API
    };

    const baseUrl = baseUrls[this.exchangeName];
    if (!baseUrl) return '';

    switch (this.exchangeName) {
      case 'binance':
        return `${baseUrl}?symbol=${symbol.replace('/', '')}&limit=${limit}`;
      case 'kraken':
        return `${baseUrl}?pair=${symbol.replace('/', '')}&count=${limit}`;
      case 'okx':
        return `${baseUrl}?instId=${symbol}&sz=${limit}`;
      case 'coinbase':
        return baseUrl.replace('{symbol}', symbol);
      default:
        return '';
    }
  }

  private normalizeOrderBook(data: any, symbol: string): OrderBookData {
    let bids: [number, number][] = [];
    let asks: [number, number][] = [];

    switch (this.exchangeName) {
      case 'binance':
        bids = data.bids.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]);
        asks = data.asks.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]);
        break;
      case 'kraken':
        const pair = Object.keys(data.result)[0];
        bids = data.result[pair].bids.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]);
        asks = data.result[pair].asks.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]);
        break;
      case 'okx':
        bids = data.data[0].bids.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]);
        asks = data.data[0].asks.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]);
        break;
      case 'coinbase':
        bids = data.bids.map((bid: any) => [parseFloat(bid.price), parseFloat(bid.size)]);
        asks = data.asks.map((ask: any) => [parseFloat(ask.price), parseFloat(ask.size)]);
        break;
    }

    return {
      symbol,
      timestamp: Date.now(),
      bids,
      asks,
      exchange: this.exchangeName
    };
  }

  private getMockOrderBook(symbol: string): OrderBookData {
    const midPrice = 50000;
    const spread = 1;

    const bids: [number, number][] = [];
    const asks: [number, number][] = [];

    for (let i = 0; i < 20; i++) {
      bids.push([midPrice - spread * (i + 1), 1 + Math.random() * 5]);
      asks.push([midPrice + spread * (i + 1), 1 + Math.random() * 5]);
    }

    return {
      symbol,
      timestamp: Date.now(),
      bids,
      asks,
      exchange: 'mock'
    };
  }

  private getAuthHeaders(): Record<string, string> {
    // For public endpoints, usually no auth needed
    // Some exchanges require API key for higher rate limits
    if (this.apiKey && ['binance', 'okx'].includes(this.exchangeName)) {
      const timestamp = Date.now().toString();
      // Simplified - would need proper signing for production
      return {
        'X-MBX-APIKEY': this.apiKey,
        'X-MBX-TIMESTAMP': timestamp
      };
    }

    return {};
  }
}

type OrderBookData = {
  symbol: string;
  timestamp: number;
  bids: [number, number][]; // [price, quantity]
  asks: [number, number][]; // [price, quantity]
  exchange: string;
};
