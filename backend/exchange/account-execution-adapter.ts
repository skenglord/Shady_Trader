import { createHash } from 'node:crypto';

export type ExchangeName = 'binance' | 'kraken' | 'okx' | 'coinbase';
export type ExchangeEnvironment = 'production' | 'testnet' | 'sandbox';
export type ExchangeSide = 'buy' | 'sell';
export type ExchangeOrderStatus =
  | 'pending'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired'
  | 'unknown';

export interface PlaceExchangeOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: ExchangeSide;
  quantity: number;
  orderType: 'market' | 'limit';
  price?: number;
}

export interface ExchangeOrderQuery {
  symbol: string;
  exchangeOrderId?: string;
  clientOrderId?: string;
}

export interface NormalizedExchangeOrder {
  exchangeOrderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: ExchangeSide;
  requestedQuantity: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  status: ExchangeOrderStatus;
  updatedAt: number;
}

export interface NormalizedExchangeFill {
  exchangeOrderId: string;
  exchangeFillId: string;
  clientOrderId?: string | null;
  symbol: string;
  side: ExchangeSide;
  quantity: number;
  price: number;
  fee: number;
  feeCurrency: string | null;
  timestamp: number;
}

export interface ExchangePage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ExchangeCapabilities {
  supportsLiveTrading: boolean;
  supportsAuthenticatedReads: boolean;
  supportsClientOrderIds: boolean;
}

/**
 * One authenticated account surface shared by order placement and recovery.
 * listOpenOrders must return all pages or reject; partial snapshots are unsafe.
 */
export interface AccountExecutionAdapter {
  readonly exchange: ExchangeName;
  readonly environment: ExchangeEnvironment;
  readonly accountId: string;
  readonly capabilities: ExchangeCapabilities;
  placeOrder(request: PlaceExchangeOrderRequest): Promise<NormalizedExchangeOrder>;
  /** null is reserved for an authoritative not-found response. */
  getOrder(query: ExchangeOrderQuery): Promise<NormalizedExchangeOrder | null>;
  listOpenOrders(): Promise<NormalizedExchangeOrder[]>;
  listOrders(since: number, cursor?: string): Promise<ExchangePage<NormalizedExchangeOrder>>;
  listFills(since: number, cursor?: string): Promise<ExchangePage<NormalizedExchangeFill>>;
  getBalances(): Promise<Record<string, number>>;
}

/** Returns an account scope that never embeds credentials or crosses venues/environments. */
export function getExchangeAccountId(
  exchange: ExchangeName,
  environment: ExchangeEnvironment,
  apiKey: string,
  configuredId?: string
): string {
  const prefix = `${exchange}:${environment}`;
  const explicitId = configuredId?.trim();
  if (explicitId) return `${prefix}:${explicitId}`;

  const keyFingerprint = createHash('sha256')
    .update(apiKey || 'unconfigured')
    .digest('hex')
    .slice(0, 32);
  return `${prefix}:${keyFingerprint}`;
}
