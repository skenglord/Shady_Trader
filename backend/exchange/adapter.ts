import axios from 'axios';
import crypto from 'crypto';

export type ExchangeName = 'binance' | 'kraken' | 'okx' | 'coinbase';

export interface OrderBookEntry {
  price: number;
  quantity: number;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  timestamp: number;
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  leverage: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'oco';
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  status: 'pending' | 'open' | 'filled' | 'canceled' | 'expired';
  timestamp: number;
  linkedOrderId?: string; // For OCO orders
}

export abstract class BaseExchangeAdapter {
  protected apiKey: string;
  protected apiSecret: string;
  protected apiPassword?: string;
  protected testnet: boolean;

  constructor(apiKey: string, apiSecret: string, apiPassword?: string, testnet: boolean = true) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassword = apiPassword;
    this.testnet = testnet;
  }

  abstract getName(): ExchangeName;
  abstract placeOrder(order: Omit<Order, 'id' | 'status' | 'timestamp'>): Promise<Order>;
  abstract placeOCOOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    stopPrice: number,
    takeProfitPrice: number
  ): Promise<{ stopOrder: Order; takeProfitOrder: Order }>;
  abstract cancelOrder(orderId: string): Promise<boolean>;
  abstract getPositions(): Promise<Position[]>;
  abstract getOrderBook(symbol: string, depth: number): Promise<OrderBook>;
  abstract getBalance(): Promise<Record<string, number>>;
}

export class BinanceAdapter extends BaseExchangeAdapter {
  getName(): ExchangeName {
    return 'binance';
  }

  private getBaseUrl(): string {
    return this.testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  }

  private signRequest(query: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  async placeOrder(order: Omit<Order, 'id' | 'status' | 'timestamp'>): Promise<Order> {
    const pair = order.symbol.replace('/', '');
    const params = new URLSearchParams({
      symbol: pair,
      side: order.side.toUpperCase(),
      type: order.type.toUpperCase(),
      quantity: String(order.quantity),
      timestamp: String(Date.now())
    });

    if (order.type === 'limit' && order.price) {
      params.set('price', String(order.price));
      params.set('timeInForce', 'GTC');
    }

    const signature = this.signRequest(params.toString());
    params.set('signature', signature);

    const response = await axios.post(`${this.getBaseUrl()}/api/v3/order`, params.toString(), {
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    return {
      ...order,
      id: String(response.data.orderId),
      status: response.data.status === 'FILLED' ? 'filled' : 'open',
      timestamp: response.data.transactTime
    };
  }

  async placeOCOOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    stopPrice: number,
    takeProfitPrice: number
  ): Promise<{ stopOrder: Order; takeProfitOrder: Order }> {
    const pair = symbol.replace('/', '');
    const params = new URLSearchParams({
      symbol: pair,
      side: side.toUpperCase(),
      quantity: String(quantity),
      price: String(takeProfitPrice),
      stopPrice: String(stopPrice),
      stopLimitPrice: String(stopPrice), // Required for OCO
      timestamp: String(Date.now())
    });

    const signature = this.signRequest(params.toString());
    params.set('signature', signature);

    const response = await axios.post(`${this.getBaseUrl()}/api/v3/order/oco`, params.toString(), {
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const ocoData = response.data.orders;
    const stopOrderData = ocoData.find((o: any) => o.type === 'STOP_LOSS_LIMIT');
    const tpOrderData = ocoData.find((o: any) => o.type === 'LIMIT_MAKER');

    const stopOrder: Order = {
      id: String(stopOrderData.orderId),
      symbol,
      side,
      type: 'stop',
      quantity,
      stopPrice,
      status: 'open',
      timestamp: response.data.transactTime
    };

    const takeProfitOrder: Order = {
      id: String(tpOrderData.orderId),
      symbol,
      side,
      type: 'limit',
      quantity,
      price: takeProfitPrice,
      status: 'open',
      timestamp: response.data.transactTime
    };

    return { stopOrder, takeProfitOrder };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    // Implementation similar to existing connector
    return true;
  }

  async getPositions(): Promise<Position[]> {
    // Implementation for getting positions
    return [];
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBook> {
    const pair = symbol.replace('/', '');
    const response = await axios.get(`${this.getBaseUrl()}/api/v3/depth`, {
      params: { symbol: pair, limit: depth }
    });

    return {
      bids: response.data.bids.map(([price, qty]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty)
      })),
      asks: response.data.asks.map(([price, qty]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty)
      })),
      timestamp: Date.now()
    };
  }

  async getBalance(): Promise<Record<string, number>> {
    const params = new URLSearchParams({ timestamp: String(Date.now()) });
    params.set('signature', this.signRequest(params.toString()));

    const response = await axios.get(`${this.getBaseUrl()}/api/v3/account`, {
      params,
      headers: { 'X-MBX-APIKEY': this.apiKey }
    });

    const balances: Record<string, number> = {};
    for (const balance of response.data.balances) {
      const free = parseFloat(balance.free);
      if (free > 0) balances[balance.asset] = free;
    }
    return balances;
  }
}

// Similar implementations for KrakenAdapter, OkxAdapter, CoinbaseAdapter
export class KrakenAdapter extends BaseExchangeAdapter {
  getName(): ExchangeName {
    return 'kraken';
  }

  async placeOrder(order: Omit<Order, 'id' | 'status' | 'timestamp'>): Promise<Order> {
    // Implementation
    return { ...order, id: 'kraken-order', status: 'open', timestamp: Date.now() };
  }

  async placeOCOOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    stopPrice: number,
    takeProfitPrice: number
  ): Promise<{ stopOrder: Order; takeProfitOrder: Order }> {
    // Kraken doesn't support native OCO, simulate with two orders
    const stopOrder = await this.placeOrder({
      symbol,
      side: side === 'buy' ? 'sell' : 'buy',
      type: 'stop',
      quantity,
      stopPrice
    });

    const takeProfitOrder = await this.placeOrder({
      symbol,
      side: side === 'buy' ? 'sell' : 'buy',
      type: 'limit',
      quantity,
      price: takeProfitPrice
    });

    return { stopOrder, takeProfitOrder };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return true;
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBook> {
    const response = await axios.get('https://api.kraken.com/0/public/Depth', {
      params: { pair: symbol.replace('/', ''), count: depth }
    });

    const pair = Object.keys(response.data.result)[0];
    return {
      bids: response.data.result[pair].bids.map(([price, qty]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty)
      })),
      asks: response.data.result[pair].asks.map(([price, qty]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty)
      })),
      timestamp: Date.now()
    };
  }

  async getBalance(): Promise<Record<string, number>> {
    // Implementation
    return {};
  }
}

export class OkxAdapter extends BaseExchangeAdapter {
  getName(): ExchangeName {
    return 'okx';
  }

  async placeOrder(order: Omit<Order, 'id' | 'status' | 'timestamp'>): Promise<Order> {
    // Implementation
    return { ...order, id: 'okx-order', status: 'open', timestamp: Date.now() };
  }

  async placeOCOOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    stopPrice: number,
    takeProfitPrice: number
  ): Promise<{ stopOrder: Order; takeProfitOrder: Order }> {
    // OKX supports OCO orders
    const stopOrder = await this.placeOrder({
      symbol,
      side: side === 'buy' ? 'sell' : 'buy',
      type: 'stop',
      quantity,
      stopPrice
    });

    const takeProfitOrder = await this.placeOrder({
      symbol,
      side: side === 'buy' ? 'sell' : 'buy',
      type: 'limit',
      quantity,
      price: takeProfitPrice
    });

    return { stopOrder, takeProfitOrder };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return true;
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBook> {
    const response = await axios.get('https://www.okx.com/api/v5/market/books', {
      params: { instId: symbol, sz: depth }
    });

    return {
      bids: response.data.data[0].bids.map(([price, qty]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty)
      })),
      asks: response.data.data[0].asks.map(([price, qty]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty)
      })),
      timestamp: Date.now()
    };
  }

  async getBalance(): Promise<Record<string, number>> {
    // Implementation
    return {};
  }
}

export class CoinbaseAdapter extends BaseExchangeAdapter {
  getName(): ExchangeName {
    return 'coinbase';
  }

  async placeOrder(order: Omit<Order, 'id' | 'status' | 'timestamp'>): Promise<Order> {
    // Implementation
    return { ...order, id: 'coinbase-order', status: 'open', timestamp: Date.now() };
  }

  async placeOCOOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    stopPrice: number,
    takeProfitPrice: number
  ): Promise<{ stopOrder: Order; takeProfitOrder: Order }> {
    // Coinbase doesn't support native OCO, simulate with two orders
    const stopOrder = await this.placeOrder({
      symbol,
      side: side === 'buy' ? 'sell' : 'buy',
      type: 'stop',
      quantity,
      stopPrice
    });

    const takeProfitOrder = await this.placeOrder({
      symbol,
      side: side === 'buy' ? 'sell' : 'buy',
      type: 'limit',
      quantity,
      price: takeProfitPrice
    });

    return { stopOrder, takeProfitOrder };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return true;
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBook> {
    const response = await axios.get(`https://api.exchange.coinbase.com/products/${symbol}/book`, {
      params: { level: 2 }
    });

    return {
      bids: response.data.bids.slice(0, depth).map((bid: any) => ({
        price: parseFloat(bid[0]),
        quantity: parseFloat(bid[1])
      })),
      asks: response.data.asks.slice(0, depth).map((ask: any) => ({
        price: parseFloat(ask[0]),
        quantity: parseFloat(ask[1])
      })),
      timestamp: Date.now()
    };
  }

  async getBalance(): Promise<Record<string, number>> {
    // Implementation
    return {};
  }
}

export class ExchangeAdapterFactory {
  static createAdapter(
    exchange: ExchangeName,
    apiKey: string,
    apiSecret: string,
    apiPassword?: string,
    testnet: boolean = true
  ): BaseExchangeAdapter {
    switch (exchange) {
      case 'binance':
        return new BinanceAdapter(apiKey, apiSecret, apiPassword, testnet);
      case 'kraken':
        return new KrakenAdapter(apiKey, apiSecret, apiPassword, testnet);
      case 'okx':
        return new OkxAdapter(apiKey, apiSecret, apiPassword, testnet);
      case 'coinbase':
        return new CoinbaseAdapter(apiKey, apiSecret, apiPassword, testnet);
      default:
        throw new Error(`Unsupported exchange: ${exchange}`);
    }
  }
}