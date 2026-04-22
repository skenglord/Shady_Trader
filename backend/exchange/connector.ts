import { runQuery } from '../database.js';
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../logging/logger.js';

type ExchangeName = 'coinmarketcap' | 'binance' | 'kraken';
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
    logger.info('ExchangeConnector initialized', {
      service: 'ExchangeConnector',
      exchangeName: this.exchangeName,
      testnet: this.testnet
    });
    this.executionAdapter = this.createExecutionAdapter();
    this.startLiveUpdates();
  }

  private normalizeExchangeName(name: string): ExchangeName {
    const normalized = String(name || 'coinmarketcap').toLowerCase();
    if (normalized === 'binance' || normalized === 'kraken' || normalized === 'coinmarketcap') {
      return normalized;
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

  getCapabilities() {
    return this.executionAdapter.capabilities;
  }

  private getBinanceBaseUrl(): string {
    return this.testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
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
      logger.error('Price fetch failed', {
        service: 'ExchangeConnector',
        exchangeName: this.exchangeName,
        error: error.response?.data || error.message
      });
    }
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

  async getCurrentPrice(symbol: string) {
    if (Date.now() - this.lastUpdate > 10000) {
      await this.fetchLatestPrice(symbol);
    }
    return this.currentPrice;
  }
}
