import axios from 'axios';
import { logger } from '../logging/logger.js';
import { runQuery } from '../database.js';

export interface MarketData {
  market_cap: number;
  total_volume: number;
  fear_greed_index: number;
  fear_greed_value: string;
  btc_dominance: number;
  last_updated: number;
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
    return `${this.baseUrl}${endpoint}${endpoint.includes('?') ? '&' : '?'}x_cg_demo_api_key=${this.cgApiKey}`;
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
      const globalResponse = await axios.get(this.getUrl('/global'));
      const globalData = globalResponse.data.data;

      // 2. Fetch Fear & Greed Index from alternative.me
      const fgResponse = await axios.get('https://api.alternative.me/fng/');
      const fgData = fgResponse.data.data[0];

      const marketData: MarketData = {
        market_cap: globalData.total_market_cap.usd,
        total_volume: globalData.total_volume.usd,
        fear_greed_index: parseInt(fgData.value),
        fear_greed_value: fgData.value_classification,
        btc_dominance: globalData.market_cap_percentage.btc,
        last_updated: Date.now()
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
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AdaptiveTradingSystem/1.0)' }
        });
        const ccvData = ccvRes.data;
        if (Array.isArray(ccvData?.articles) && ccvData.articles.length > 0) {
          newsItems = ccvData.articles.map((a: any) => ({
            id: a.id || a.url || Math.random().toString(36).substr(2, 9),
            title: a.title || 'No Title',
            url: a.url || '#',
            source: a.source || 'CryptoNews',
            timestamp: new Date(a.published_at || a.publishedAt || Date.now()).getTime()
          }));
        }
      } catch (e) {
        logger.warn('cryptocurrency.cv news failed, trying CoinGecko fallback', { service: 'MarketDataService' });
      }

      // Fallback 1: CoinGecko
      if (newsItems.length === 0) {
        try {
          const response = await axios.get(this.getUrl('/news'));
          newsItems = response.data.data || response.data || [];
        } catch (e) {
          logger.warn('CoinGecko news failed, trying CryptoCompare fallback', { service: 'MarketDataService' });
        }
      }

      // Fallback 2: CryptoCompare
      if (newsItems.length === 0) {
        const ccApiKey = process.env.CRYPTOCOMPARE_API_KEY || '';
        const fallbackRes = await axios.get(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN${ccApiKey ? `&api_key=${ccApiKey}` : ''}`);
        newsItems = fallbackRes.data.Data || [];
      }

      if (!Array.isArray(newsItems)) {
        logger.warn('News items is not an array', { service: 'MarketDataService' });
        return [];
      }

      const news: MarketNews[] = newsItems.map((item: any) => ({
        id: String(item.id || item.guid || Math.random().toString(36).substr(2, 9)),
        title: item.title || 'No Title',
        url: item.url || '#',
        source: item.source_info?.name || item.author || 'CryptoNews',
        timestamp: (item.published_on || (item.updated_at ? new Date(item.updated_at).getTime() / 1000 : Date.now() / 1000)) * 1000
      }));

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

  private async saveMarketData(data: MarketData) {
    await runQuery(`
      INSERT OR REPLACE INTO market_data (id, market_cap, total_volume, fear_greed_index, fear_greed_value, btc_dominance, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['current', data.market_cap, data.total_volume, data.fear_greed_index, data.fear_greed_value, data.btc_dominance, data.last_updated]);
  }

  private async saveNews(news: MarketNews[]) {
    for (const item of news) {
      await runQuery(`
        INSERT OR IGNORE INTO market_news (id, title, url, source, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `, [item.id, item.title, item.url, item.source, item.timestamp]);
    }
  }

  async getLatestMarketData(): Promise<MarketData | null> {
    const result = await runQuery('SELECT * FROM market_data WHERE id = ?', ['current'], 'all');
    return result.length > 0 ? result[0] : null;
  }

  async getLatestNews(limit: number = 10): Promise<MarketNews[]> {
    return await runQuery('SELECT * FROM market_news ORDER BY timestamp DESC LIMIT ?', [limit], 'all');
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
