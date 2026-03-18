import axios from 'axios';
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

  constructor(cgApiKey: string = 'CG-LCyUvdWfGJS1f6sCqi287qFb') {
    this.cgApiKey = cgApiKey;
  }

  private getUrl(endpoint: string) {
    return `${this.baseUrl}${endpoint}${endpoint.includes('?') ? '&' : '?'}x_cg_demo_api_key=${this.cgApiKey}`;
  }

  async fetchMarketData(): Promise<MarketData | null> {
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
      return marketData;
    } catch (error) {
      console.error('Error fetching market data:', error);
      return null;
    }
  }

  async fetchNews(): Promise<MarketNews[]> {
    try {
      let newsItems = [];
      try {
        const response = await axios.get(this.getUrl('/news'));
        newsItems = response.data.data || response.data || [];
      } catch (e) {
        console.warn('CoinGecko news failed, trying CryptoCompare fallback');
        const fallbackRes = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
        newsItems = fallbackRes.data.Data || [];
      }

      const news: MarketNews[] = newsItems.map((item: any) => ({
        id: item.id || item.guid || Math.random().toString(36).substr(2, 9),
        title: item.title,
        url: item.url,
        source: item.source_info?.name || item.author || 'CryptoNews',
        timestamp: (item.published_on || new Date(item.updated_at).getTime() / 1000) * 1000
      }));

      await this.saveNews(news);
      return news;
    } catch (error) {
      console.error('Error fetching news:', error);
      return [];
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
}
