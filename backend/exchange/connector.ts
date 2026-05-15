import { runQuery } from '../database.js';
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../logging/logger.js';
import { randomUUID } from 'crypto';
import { ExchangeAdapterFactory, BaseExchangeAdapter } from './adapter.js';
import { PositionReconciliationEngine } from './reconciliation.js';

type ExchangeName = 'coinmarketcap' | 'binance' | 'kraken' | 'okx' | 'coinbase';
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
  private currentPrice = 0;
  private lastUpdate = 0;
  private updateInterval: NodeJS.Timeout | null = null;
  private executionAdapter: ExecutionAdapter;
  private exchangeAdapter: BaseExchangeAdapter;
  private reconciliationEngine: PositionReconciliationEngine;
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

    // Validate credentials for non-demo exchanges in production mode
    // In testnet mode, allow empty credentials for testing purposes
    if (this.exchangeName !== 'coinmarketcap' && !this.testnet) {
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

    // Initialize new adapter system
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
    this.startLiveUpdates();
    this.startReconciliation();
  }

  private normalizeExchangeName(name: string): ExchangeName {
    const normalized = String(name || 'coinmarketcap').toLowerCase();
    const supportedExchanges: ExchangeName[] = ['coinmarketcap', 'binance', 'kraken', 'okx', 'coinbase'];
    
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
    this.reconciliationEngine.stopReconciliation();
  }

  getCapabilities() {
    return this.executionAdapter.capabilities;
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
      const response = await axios.get('https://min-api.cryptocompare.com/data/pricemulti', {
        params: {
          fsyms: baseSymbol,
          tsyms: 'USD'
        }
      });
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
      const response = await axios.get('https://min-api.cryptocompare.com/data/v2/histoday', {
        params: {
          fsym: baseSymbol,
          tsym: 'USD',
          limit: Math.min(limit, 2000),
          aggregate: interval
        }
      });

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

    return rows;
  }

  async getCandles(symbol: string, timeframe: string, limit: number = 100) {
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

    if (rows.length === 0) {
      if (this.currentPrice === 0) {
        await this.fetchLatestPrice(symbol);
      }

      const price = this.currentPrice || 50000;
      const now = Date.now();
      const msPerCandle = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 }[timeframe] || 3600000;

      rows = Array.from({ length: limit }).map((_, i) => {
        const time = now - (limit - 1 - i) * msPerCandle;
        const noise = price * 0.001;
        return {
          time,
          open: price - noise + Math.random() * noise * 2,
          high: price + Math.random() * noise * 2,
          low: price - Math.random() * noise * 2,
          close: price - noise + Math.random() * noise * 2,
          volume: Math.random() * 100
        };
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
