import { runQuery } from '../database.js';
import axios from 'axios';

export class ExchangeConnector {
  apiKey: string;
  testnet: boolean;
  private currentPrice: number = 0;
  private lastUpdate: number = 0;
  private updateInterval: NodeJS.Timeout | null = null;
  private symbolMap: Record<string, string> = {
    'BTC/USDT': 'BTC',
    'ETH/USDT': 'ETH',
    'SOL/USDT': 'SOL',
  };

  private activeSymbol: string = 'BTC/USDT';

  constructor(exchangeName: string, apiKey: string, apiSecret: string, apiPassword?: string, testnet: boolean = true) {
    console.log(`[ExchangeConnector] Constructor called for ${exchangeName}`);
    this.apiKey = 'e38ccf4560a24a308ea103d5b81f3dc1'; // Hardcoded as requested
    this.testnet = testnet;
    this.startLiveUpdates();
  }

  setActiveSymbol(symbol: string) {
    console.log(`[ExchangeConnector] Setting active symbol to ${symbol}`);
    this.activeSymbol = symbol;
  }

  private startLiveUpdates() {
    console.log(`[ExchangeConnector] Starting live updates`);
    if (this.updateInterval) clearInterval(this.updateInterval);
    
    // Call API once every 5 seconds
    this.updateInterval = setInterval(async () => {
      console.log(`[ExchangeConnector] Interval triggered for ${this.activeSymbol}`);
      try {
        await this.fetchLatestPrice(this.activeSymbol);
      } catch (e) {
        console.error('Failed to fetch live data from CoinMarketCap:', e);
      }
    }, 5000);
  }

  private async fetchLatestPrice(symbol: string) {
    const cmcSymbol = this.symbolMap[symbol] || symbol.split('/')[0];
    console.log(`[ExchangeConnector] Fetching price for ${cmcSymbol} (symbol: ${symbol})`);
    try {
      const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
        headers: {
          'X-CMC_PRO_API_KEY': this.apiKey,
          'Accept': 'application/json'
        },
        params: {
          symbol: cmcSymbol,
          convert: 'USD'
        }
      });

      console.log(`[ExchangeConnector] API response for ${cmcSymbol}:`, JSON.stringify(response.data.data[cmcSymbol]));
      
      const data = response.data.data[cmcSymbol];
      if (data && data.quote && data.quote.USD) {
        this.currentPrice = data.quote.USD.price;
        this.lastUpdate = Date.now();
        
        // Save to DB as a 1m candle for historical data building
        await this.saveTickToDb(symbol, this.currentPrice, data.quote.USD.volume_24h || 0);
      }
    } catch (e: any) {
      console.error('CMC API Error:', e.response?.data || e.message);
    }
  }

  private async saveTickToDb(symbol: string, price: number, volume: number) {
    const now = Date.now();
    // Round to nearest minute for 1m candle
    const candleTime = Math.floor(now / 60000) * 60000;
    
    try {
      await runQuery(`
        INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
        VALUES (?, '1m', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, timeframe, time) DO UPDATE SET
        high = MAX(high, excluded.high),
        low = MIN(low, excluded.low),
        close = excluded.close,
        volume = excluded.volume
      `, [symbol, candleTime, price, price, price, price, volume]);
    } catch (e) {
      console.error('Failed to save tick to DB:', e);
    }
  }

  async fetchExchangeOHLCV(symbol: string, timeframe: string, since: number, limit: number) {
    // CMC free plan doesn't support historical OHLCV directly.
    // We will return data from our local DB that we've been building.
    return this.getHistoricalCandles(symbol, timeframe, since, limit);
  }

  async getHistoricalCandles(symbol: string, timeframe: string, since: number, limit: number = 1000, toTime?: number) {
    let rows;
    
    if (toTime) {
      rows = await runQuery(`
        SELECT time, open, high, low, close, volume 
        FROM candles 
        WHERE symbol = ? AND timeframe = ? AND time >= ? AND time <= ?
        ORDER BY time ASC 
      `, [symbol, timeframe, since, toTime], 'all');
    } else {
      rows = await runQuery(`
        SELECT time, open, high, low, close, volume 
        FROM candles 
        WHERE symbol = ? AND timeframe = ? AND time >= ?
        ORDER BY time DESC 
        LIMIT ?
      `, [symbol, timeframe, since, limit], 'all');
      rows = rows.reverse();
    }
    
    return rows;
  }

  async getCandles(symbol: string, timeframe: string, limit: number = 100) {
    let rows = await runQuery(`
      SELECT time, open, high, low, close, volume 
      FROM candles 
      WHERE symbol = ? AND timeframe = ?
      ORDER BY time DESC 
      LIMIT ?
    `, [symbol, timeframe, limit], 'all');
    
    // If we don't have enough data, generate some mock data based on current price
    // to prevent the UI from breaking, since CMC free plan lacks historical data.
    if (rows.length === 0) {
      if (this.currentPrice === 0) {
        await this.fetchLatestPrice(symbol);
      }
      
      const price = this.currentPrice || 50000;
      const now = Date.now();
      const msPerCandle = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 }[timeframe] || 3600000;
      
      rows = Array.from({ length: limit }).map((_, i) => {
        const time = now - (limit - 1 - i) * msPerCandle;
        // Add some random noise
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

  async placeOrder(symbol: string, side: 'buy' | 'sell', amount: number, orderType: 'market' | 'limit' = 'market', price?: number) {
    // Mock order placement since CMC is data-only
    return {
      id: Math.random().toString(36).substring(7),
      status: 'closed',
      filled: amount,
      price: price || this.currentPrice,
      timestamp: Date.now()
    };
  }

  async getBalance() {
    // Mock balance
    return {
      'USDT': 10000,
      'BTC': 0.5
    };
  }

  async cancelOrder(orderId: string, symbol: string) {
    return true;
  }

  async getCurrentPrice(symbol: string) {
    if (Date.now() - this.lastUpdate > 10000) {
      await this.fetchLatestPrice(symbol);
    }
    return this.currentPrice;
  }
}

