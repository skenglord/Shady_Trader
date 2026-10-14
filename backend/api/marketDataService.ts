import axios from 'axios';
import { createHash } from 'node:crypto';
import { logger } from '../logging/logger.js';
import { runQuery } from '../database.js';

export interface MarketData {
  market_cap: number;
  total_volume: number;
  fear_greed_index: number;
  fear_greed_value: string;
  btc_dominance: number;
  last_updated: number;
  age_ms?: number;
  stale?: boolean;
  source?: string;
}

export interface MarketNews {
  id: string;
  title: string;
  url: string;
  source: string;
  timestamp: number;
  sentiment?: string;
  sentiment_score?: number;
}

export class MarketDataService {
  private cgApiKey: string;
  private baseUrl = 'https://api.coingecko.com/api/v3';
  private marketDataFailures = 0;
  private newsFailures = 0;
  private marketDataCircuitOpenUntil = 0;
  private newsCircuitOpenUntil = 0;
  private readonly failureThreshold = 3;
  private readonly cooldownMs = 5 * 60 * 1000;
  private metrics = {
    marketDataFetchCount: 0,
    marketDataFetchFailures: 0,
    newsFetchCount: 0,
    newsFetchFailures: 0,
    lastMarketDataFetchAt: 0,
    lastNewsFetchAt: 0
  };

  constructor(cgApiKey: string = process.env.COINGECKO_API_KEY || '') {
    this.cgApiKey = cgApiKey;
  }

  private getUrl(endpoint: string) {
    const url = `${this.baseUrl}${endpoint}`;
    if (!this.cgApiKey) return url;
    return `${url}${endpoint.includes('?') ? '&' : '?'}x_cg_demo_api_key=${encodeURIComponent(this.cgApiKey)}`;
  }

  async fetchMarketData(): Promise<MarketData | null> {
    this.metrics.marketDataFetchCount++;
    this.metrics.lastMarketDataFetchAt = Date.now();
    if (Date.now() < this.marketDataCircuitOpenUntil) {
      logger.warn('Market-data circuit open; returning cached data', { service: 'MarketDataService' });
      return this.getLatestMarketData();
    }

    try {
      // 1. Fetch Global Data from CoinGecko
      const globalResponse = await axios.get(this.getUrl('/global'), { timeout: 5000 });
      const globalData = globalResponse.data.data;

      // 2. Fetch Fear & Greed Index from alternative.me
      const fgResponse = await axios.get('https://api.alternative.me/fng/', { timeout: 5000 });
      const fgData = fgResponse.data.data[0];

      const marketData: MarketData = {
        market_cap: globalData.total_market_cap.usd,
        total_volume: globalData.total_volume.usd,
        fear_greed_index: parseInt(fgData.value),
        fear_greed_value: fgData.value_classification,
        btc_dominance: globalData.market_cap_percentage.btc,
        last_updated: this.publicationTime(globalData.updated_at) || Date.now(),
        source: 'coingecko / alternative.me'
      };

      await this.saveMarketData(marketData);
      this.marketDataFailures = 0;
      return marketData;
    } catch (error) {
      this.marketDataFailures++;
      this.metrics.marketDataFetchFailures++;
      if (this.marketDataFailures >= this.failureThreshold) {
        this.marketDataCircuitOpenUntil = Date.now() + this.cooldownMs;
      }
      logger.error('Error fetching market data', { service: 'MarketDataService', error: (error as Error).message });
      return this.getLatestMarketData();
    }
  }

  async fetchNews(): Promise<MarketNews[]> {
    this.metrics.newsFetchCount++;
    this.metrics.lastNewsFetchAt = Date.now();
    if (Date.now() < this.newsCircuitOpenUntil) {
      logger.warn('News circuit open; returning cached data', { service: 'MarketDataService' });
      return this.getLatestNews();
    }

    try {
      let newsItems = [];
      // Primary: cryptocurrency.cv (free tier, may return 0 without x402 payment)
      try {
        const ccvRes = await axios.get('https://cryptocurrency.cv/api/news?limit=20', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AdaptiveTradingSystem/1.0)' }, timeout: 5000
        });
        const ccvData = ccvRes.data;
        if (Array.isArray(ccvData?.articles) && ccvData.articles.length > 0) {
          newsItems = ccvData.articles;
        }
      } catch (e) {
        logger.warn('cryptocurrency.cv news failed, trying CoinGecko fallback', { service: 'MarketDataService' });
      }

      // Fallback 1: CoinGecko
      if (newsItems.length === 0) {
        try {
          const response = await axios.get(this.getUrl('/news'), { timeout: 5000 });
          newsItems = response.data.data || response.data || [];
        } catch (e) {
          logger.warn('CoinGecko news failed, trying CryptoCompare fallback', { service: 'MarketDataService' });
        }
      }

      // Fallback 2: CryptoCompare
      if (newsItems.length === 0) {
        const ccApiKey = process.env.CRYPTOCOMPARE_API_KEY || '';
        const fallbackRes = await axios.get(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN${ccApiKey ? `&api_key=${ccApiKey}` : ''}`, { timeout: 5000 });
        newsItems = fallbackRes.data.Data || [];
      }

      if (!Array.isArray(newsItems)) {
        logger.warn('News items is not an array', { service: 'MarketDataService' });
        return [];
      }

      const news = newsItems.flatMap((item: any): MarketNews[] => {
        const timestamp = this.publicationTime(item.timestamp ?? item.published_on ?? item.published_at ?? item.publishedAt ?? item.updated_at);
        const publisher = item.source_info?.name || (typeof item.source === 'string' ? item.source : item.source?.name) || item.author;
        let url: URL;
        try { url = new URL(item.url); } catch { return []; }
        if (!['https:', 'http:'].includes(url.protocol) || !timestamp || timestamp > Date.now() + 300_000 || !item.title) return [];
        return [{ id: String(item.id || item.guid || createHash('sha256').update(url.href).digest('hex')),
          title: item.title, url: url.href, source: publisher || url.hostname, timestamp }];
      });

      await this.saveNews(news);
      this.newsFailures = 0;
      return news;
    } catch (error) {
      this.newsFailures++;
      this.metrics.newsFetchFailures++;
      if (this.newsFailures >= this.failureThreshold) {
        this.newsCircuitOpenUntil = Date.now() + this.cooldownMs;
      }
      logger.error('Error fetching news', { service: 'MarketDataService', error: (error as Error).message });
      return this.getLatestNews();
    }
  }

  private publicationTime(value: unknown): number | null {
    if (value == null || value === '') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    const time = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(String(value));
    return Number.isFinite(time) && time > 0 ? time : null;
  }

  private async saveMarketData(data: MarketData) {
    await runQuery(`
      INSERT OR REPLACE INTO market_data (id, market_cap, total_volume, fear_greed_index, fear_greed_value, btc_dominance, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['current', data.market_cap, data.total_volume, data.fear_greed_index, data.fear_greed_value, data.btc_dominance, data.last_updated]);
  }

  private async saveNews(news: MarketNews[]) {
    for (const item of news) {
      await runQuery(`
        INSERT INTO market_news (id, title, url, source, timestamp)
        VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, source=excluded.source, timestamp=excluded.timestamp
      `, [item.id, item.title, item.url, item.source, item.timestamp]);
    }
  }

  async getLatestMarketData(): Promise<MarketData | null> {
    const result = await runQuery('SELECT * FROM market_data WHERE id = ?', ['current'], 'all');
    return result.length > 0 ? { ...result[0], age_ms: Date.now() - result[0].last_updated, stale: Date.now() - result[0].last_updated > 15 * 60_000, source: 'coingecko / alternative.me' } : null;
  }

  async getLatestNews(limit: number = 10): Promise<MarketNews[]> {
    const rows = await runQuery("SELECT * FROM market_news WHERE url LIKE 'https://%' OR url LIKE 'http://%' ORDER BY timestamp DESC LIMIT ?", [limit], 'all');
    return rows;
  }

  getMetrics() {
    return {
      ...this.metrics,
      marketDataCircuitOpen: Date.now() < this.marketDataCircuitOpenUntil,
      newsCircuitOpen: Date.now() < this.newsCircuitOpenUntil,
      marketDataCircuitOpenUntil: this.marketDataCircuitOpenUntil,
      newsCircuitOpenUntil: this.newsCircuitOpenUntil
    };
  }
}
