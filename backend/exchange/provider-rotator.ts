import axios from 'axios';
import { logger } from '../logging/logger';

// ── Types ──────────────────────────────────────────────────────

export type ProviderName = 'coingecko' | 'binance' | 'coinmarketcap' | 'coinapi';

interface ProviderHealth {
  name: ProviderName;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  lastFailure: number;
  lastSuccess: number;
  circuitOpenUntil: number;
  consecutiveTimeouts: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ProviderConfig {
  name: ProviderName;
  priority: number;
  apiKey: string;
  apiSecret?: string;
  timeoutMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
}

// ── ProviderRotator ────────────────────────────────────────────

export class ProviderRotator {
  private providers: ProviderConfig[];
  private health: Map<ProviderName, ProviderHealth> = new Map();
  private activeProvider: ProviderName;
  private readonly TIMEOUT_MS = 5000;
  private readonly CIRCUIT_THRESHOLD = 3;
  private readonly CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    primaryProvider: ProviderName = 'coingecko',
    apiKeys: Partial<Record<ProviderName, string>> = {},
    apiSecrets: Partial<Record<ProviderName, string>> = {}
  ) {
    this.activeProvider = primaryProvider;

    this.providers = [
      {
        name: 'coingecko',
        priority: 0,
        apiKey: apiKeys.coingecko || '',
        timeoutMs: this.TIMEOUT_MS,
        circuitBreakerThreshold: this.CIRCUIT_THRESHOLD,
        circuitBreakerCooldownMs: this.CIRCUIT_COOLDOWN_MS,
      },
      {
        name: 'binance',
        priority: 1,
        apiKey: apiKeys.binance || '',
        apiSecret: apiSecrets.binance || '',
        timeoutMs: this.TIMEOUT_MS,
        circuitBreakerThreshold: this.CIRCUIT_THRESHOLD,
        circuitBreakerCooldownMs: this.CIRCUIT_COOLDOWN_MS,
      },
      {
        name: 'coinmarketcap',
        priority: 2,
        apiKey: apiKeys.coinmarketcap || '',
        timeoutMs: this.TIMEOUT_MS,
        circuitBreakerThreshold: this.CIRCUIT_THRESHOLD,
        circuitBreakerCooldownMs: this.CIRCUIT_COOLDOWN_MS,
      },
      {
        name: 'coinapi',
        priority: 3,
        apiKey: apiKeys.coinapi || '',
        timeoutMs: this.TIMEOUT_MS,
        circuitBreakerThreshold: this.CIRCUIT_THRESHOLD,
        circuitBreakerCooldownMs: this.CIRCUIT_COOLDOWN_MS,
      },
    ];

    // Initialize health tracking
    for (const p of this.providers) {
      this.health.set(p.name, {
        name: p.name,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        lastFailure: 0,
        lastSuccess: 0,
        circuitOpenUntil: 0,
        consecutiveTimeouts: 0,
      });
    }

    logger.info('[ProviderRotator] Initialized', {
      service: 'ProviderRotator',
      primary: primaryProvider,
      chain: this.providers.map(p => p.name),
    });
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Fetch candles with automatic provider rotation.
   * Tries each provider in priority order. If a provider times out (>5s)
   * or fails, rotates to the next one. Returns empty array if all fail.
   */
  async getCandles(symbol: string, timeframe: string, limit: number = 200): Promise<Candle[]> {
    const orderedProviders = this.getAvailableProviders();

    for (const config of orderedProviders) {
      const h = this.health.get(config.name)!;

      // Skip if circuit breaker is open
      if (Date.now() < h.circuitOpenUntil) {
        continue;
      }

      try {
        const start = Date.now();
        const candles = await this.fetchFromProvider(config, symbol, timeframe, limit);
        const latency = Date.now() - start;

        if (candles.length > 0) {
          this.recordSuccess(config.name, latency);
          if (config.name !== this.activeProvider) {
            logger.info(`[ProviderRotator] Switched to ${config.name} (was ${this.activeProvider})`, {
              service: 'ProviderRotator',
              candles: candles.length,
              latency,
            });
            this.activeProvider = config.name;
          }
          return candles;
        }
      } catch (err: any) {
        this.recordFailure(config.name, err);
        logger.warn(`[ProviderRotator] ${config.name} failed: ${err.message}`, {
          service: 'ProviderRotator',
          consecutive: this.health.get(config.name)?.consecutiveTimeouts,
        });
      }
    }

    logger.error('[ProviderRotator] All providers failed', { service: 'ProviderRotator' });
    return [];
  }

  /**
   * Fetch current price with rotation.
   */
  async fetchPrice(symbol: string): Promise<number> {
    const orderedProviders = this.getAvailableProviders();

    for (const config of orderedProviders) {
      const h = this.health.get(config.name)!;
      if (Date.now() < h.circuitOpenUntil) continue;

      try {
        const start = Date.now();
        const price = await this.fetchPriceFromProvider(config, symbol);
        const latency = Date.now() - start;

        if (price > 0) {
          this.recordSuccess(config.name, latency);
          return price;
        }
      } catch (err: any) {
        this.recordFailure(config.name, err);
      }
    }

    return 0;
  }

  /**
   * Get current active provider name.
   */
  getActiveProvider(): ProviderName {
    return this.activeProvider;
  }

  /**
   * Get health status for all providers.
   */
  getHealth(): ProviderHealth[] {
    return this.providers.map(p => ({ ...this.health.get(p.name)! }));
  }

  /**
   * Get a summary for diagnostics.
   */
  getSummary(): Record<string, unknown> {
    const now = Date.now();
    return {
      activeProvider: this.activeProvider,
      providers: this.providers.map(p => {
        const h = this.health.get(p.name)!;
        return {
          name: p.name,
          available: now >= h.circuitOpenUntil,
          circuitOpen: now < h.circuitOpenUntil,
          circuitRemainingSec: Math.max(0, Math.ceil((h.circuitOpenUntil - now) / 1000)),
          successes: h.successCount,
          failures: h.failureCount,
          avgLatencyMs: h.successCount > 0 ? Math.round(h.totalLatencyMs / h.successCount) : 0,
          consecutiveTimeouts: h.consecutiveTimeouts,
        };
      }),
    };
  }

  // ── Private: Provider Selection ────────────────────────────

  private getAvailableProviders(): ProviderConfig[] {
    const now = Date.now();
    return this.providers.filter(p => {
      const h = this.health.get(p.name)!;
      return now >= h.circuitOpenUntil;
    });
  }

  // ── Private: Health Tracking ───────────────────────────────

  private recordSuccess(provider: ProviderName, latencyMs: number): void {
    const h = this.health.get(provider)!;
    h.successCount++;
    h.totalLatencyMs += latencyMs;
    h.lastSuccess = Date.now();
    h.consecutiveTimeouts = 0;
  }

  private recordFailure(provider: ProviderName, err: Error): void {
    const h = this.health.get(provider)!;
    h.failureCount++;
    h.lastFailure = Date.now();
    h.consecutiveTimeouts++;

    if (h.consecutiveTimeouts >= this.CIRCUIT_THRESHOLD) {
      h.circuitOpenUntil = Date.now() + this.CIRCUIT_COOLDOWN_MS;
      logger.warn(`[ProviderRotator] Circuit breaker OPEN for ${provider} (${this.CIRCUIT_COOLDOWN_MS / 1000}s cooldown)`, {
        service: 'ProviderRotator',
        consecutive: h.consecutiveTimeouts,
      });
    }
  }

  // ── Private: Provider-Specific Fetch ───────────────────────

  private async fetchFromProvider(
    config: ProviderConfig,
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<Candle[]> {
    switch (config.name) {
      case 'coingecko':
        return this.fetchCoinGecko(symbol, timeframe, limit, config);
      case 'binance':
        return this.fetchBinance(symbol, timeframe, limit, config);
      case 'coinmarketcap':
        return this.fetchCoinMarketCap(symbol, timeframe, limit, config);
      case 'coinapi':
        return this.fetchCoinAPI(symbol, timeframe, limit, config);
      default:
        return [];
    }
  }

  private async fetchPriceFromProvider(config: ProviderConfig, symbol: string): Promise<number> {
    const baseSymbol = symbol.split('/')[0];
    const quoteSymbol = symbol.split('/')[1] || 'USD';

    switch (config.name) {
      case 'coingecko': {
        const coinIdMap: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };
        const coinId = coinIdMap[baseSymbol] || baseSymbol.toLowerCase();
        const params: Record<string, any> = { ids: coinId, vs_currencies: 'usd' };
        if (config.apiKey) params.x_cg_demo_api_key = config.apiKey;
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
          params,
          timeout: this.TIMEOUT_MS,
        });
        return Number(res.data?.[coinId]?.usd || 0);
      }
      case 'binance': {
        const pair = `${baseSymbol}${quoteSymbol}`;
        const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
          params: { symbol: pair },
          timeout: this.TIMEOUT_MS,
        });
        return Number(res.data?.lastPrice || 0);
      }
      case 'coinmarketcap': {
        const res = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
          headers: { 'X-CMC_PRO_API_KEY': config.apiKey, Accept: 'application/json' },
          params: { symbol: baseSymbol, convert: quoteSymbol },
          timeout: this.TIMEOUT_MS,
        });
        const data = res.data?.data?.[baseSymbol]?.quote?.[quoteSymbol];
        return Number(data?.price || 0);
      }
      case 'coinapi': {
        const res = await axios.get(
          `https://rest.coinapi.io/v1/exchangerate/${baseSymbol}/${quoteSymbol}`,
          {
            headers: { 'X-CoinAPI-Key': config.apiKey, Accept: 'application/json' },
            timeout: this.TIMEOUT_MS,
          }
        );
        return Number(res.data?.rate || 0);
      }
      default:
        return 0;
    }
  }

  // ── Private: Candle Fetch Implementations ──────────────────

  private timeframeToBinanceInterval(tf: string): string {
    const map: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '1d': '1d' };
    return map[tf] || '1h';
  }

  private timeframeToCoinAPIGranularity(tf: string): string {
    const map: Record<string, string> = { '1m': '1MIN', '5m': '5MIN', '15m': '15MIN', '1h': '1HRS', '1d': '1DAY' };
    return map[tf] || '1HRS';
  }

  private async fetchCoinGecko(
    symbol: string, timeframe: string, limit: number, config: ProviderConfig
  ): Promise<Candle[]> {
    const baseSymbol = symbol.split('/')[0];
    const coinIdMap: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };
    const coinId = coinIdMap[baseSymbol] || baseSymbol.toLowerCase();

    const daysMap: Record<string, string> = { '1m': '1', '5m': '1', '15m': '2', '1h': '30', '1d': '90' };
    const days = daysMap[timeframe] || '30';

    const params: Record<string, any> = {
      vs_currency: 'usd',
      days,
      interval: timeframe === '1d' ? 'daily' : 'auto',
    };
    if (config.apiKey) params.x_cg_demo_api_key = config.apiKey;

    const res = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`,
      { params, timeout: this.TIMEOUT_MS }
    );

    const raw: [number, number, number, number, number][] = res.data || [];
    return raw.slice(-limit).map(([time, open, high, low, close]) => ({
      time, open, high, low, close, volume: 0,
    }));
  }

  private async fetchBinance(
    symbol: string, timeframe: string, limit: number, config: ProviderConfig
  ): Promise<Candle[]> {
    const pair = symbol.replace('/', '');
    const interval = this.timeframeToBinanceInterval(timeframe);

    const res = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: pair, interval, limit },
      timeout: this.TIMEOUT_MS,
    });

    return (res.data || []).map((k: any[]) => ({
      time: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }

  private async fetchCoinMarketCap(
    symbol: string, timeframe: string, limit: number, config: ProviderConfig
  ): Promise<Candle[]> {
    const baseSymbol = symbol.split('/')[0];
    const quoteSymbol = symbol.split('/')[1] || 'USD';

    // CMC doesn't have a direct OHLC endpoint on free tier.
    // Use the historical quotes endpoint with time periodicity.
    const periodMap: Record<string, string> = { '1d': 'daily', '1h': 'hourly' };
    const period = periodMap[timeframe] || 'hourly';

    const res = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/historical',
      {
        headers: { 'X-CMC_PRO_API_KEY': config.apiKey, Accept: 'application/json' },
        params: {
          symbol: baseSymbol,
          convert: quoteSymbol,
          time_period: period,
          count: Math.min(limit, 100),
        },
        timeout: this.TIMEOUT_MS,
      }
    );

    const quotes = res.data?.data?.quotes || [];
    return quotes.map((q: any) => {
      const quote = q.quote?.[quoteSymbol] || {};
      return {
        time: new Date(q.timestamp).getTime(),
        open: Number(quote.open || quote.price || 0),
        high: Number(quote.high || quote.price || 0),
        low: Number(quote.low || quote.price || 0),
        close: Number(quote.close || quote.price || 0),
        volume: Number(quote.volume || 0),
      };
    });
  }

  private async fetchCoinAPI(
    symbol: string, timeframe: string, limit: number, config: ProviderConfig
  ): Promise<Candle[]> {
    const baseSymbol = symbol.split('/')[0];
    const quoteSymbol = symbol.split('/')[1] || 'USD';
    const granularity = this.timeframeToCoinAPIGranularity(timeframe);

    const now = new Date();
    const periodMs: Record<string, number> = {
      '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000,
    };
    const ms = periodMs[timeframe] || 3600000;
    const startTime = new Date(now.getTime() - limit * ms).toISOString();
    const endTime = now.toISOString();

    const res = await axios.get(
      `https://rest.coinapi.io/v1/ohlcv/${baseSymbol}/${quoteSymbol}/${granularity}`,
      {
        headers: { 'X-CoinAPI-Key': config.apiKey, Accept: 'application/json' },
        params: { period_id: granularity, time_start: startTime, time_end: endTime, limit },
        timeout: this.TIMEOUT_MS,
      }
    );

    return (res.data || []).map((c: any) => ({
      time: new Date(c.time_period_start).getTime(),
      open: Number(c.price_open),
      high: Number(c.price_high),
      low: Number(c.price_low),
      close: Number(c.price_close),
      volume: Number(c.volume_traded || 0),
    }));
  }
}
