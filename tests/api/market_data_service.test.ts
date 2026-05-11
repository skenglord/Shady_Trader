import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { MarketDataService } from '../../backend/api/marketDataService.js';

const originalGet = axios.get;

afterEach(() => {
  axios.get = originalGet;
});

describe('MarketDataService', () => {
  test('fetchMarketData saves and returns normalized payload', async () => {
    let saveCalls = 0;
    axios.get = (async (url: string) => {
      if (url.includes('/global')) {
        return {
          data: {
            data: {
              total_market_cap: { usd: 123 },
              total_volume: { usd: 456 },
              market_cap_percentage: { btc: 54.3 }
            }
          }
        };
      }
      return { data: { data: [{ value: '70', value_classification: 'Greed' }] } };
    }) as any;

    const service = new MarketDataService('demo');
    (service as any).saveMarketData = async () => {
      saveCalls += 1;
    };

    const data = await service.fetchMarketData();
    assert.ok(data);
    assert.strictEqual(data?.market_cap, 123);
    assert.strictEqual(data?.fear_greed_index, 70);
    assert.strictEqual(saveCalls, 1);
  });

  test('fetchMarketData falls back to cache and opens circuit after repeated failures', async () => {
    axios.get = (async () => {
      throw new Error('network down');
    }) as any;

    const service = new MarketDataService('demo');
    (service as any).getLatestMarketData = async () => ({ market_cap: 1, last_updated: Date.now() });

    await service.fetchMarketData();
    await service.fetchMarketData();
    const cached = await service.fetchMarketData();
    assert.ok(cached);

    const metrics = service.getMetrics();
    assert.strictEqual(metrics.marketDataFetchFailures, 3);
    assert.strictEqual(metrics.marketDataCircuitOpen, true);
  });

  test('fetchNews uses CryptoCompare fallback when CoinGecko news fails', async () => {
    axios.get = (async (url: string) => {
      if (url.includes('/news') && url.includes('coingecko')) {
        throw new Error('coingecko news unavailable');
      }
      return {
        data: {
          Data: [
            {
              id: 'news-1',
              title: 'BTC rises',
              url: 'https://example.com/news',
              author: 'desk',
              published_on: 1_700_000_000
            }
          ]
        }
      };
    }) as any;

    const service = new MarketDataService('demo');
    (service as any).saveNews = async () => undefined;
    const news = await service.fetchNews();
    assert.strictEqual(news.length, 1);
    assert.strictEqual(news[0].id, 'news-1');
  });

  test('fetchNews returns cached news after failures exceed threshold', async () => {
    axios.get = (async () => {
      throw new Error('all providers down');
    }) as any;

    const service = new MarketDataService('demo');
    (service as any).getLatestNews = async () => [{ id: 'cached-news' }];

    await service.fetchNews();
    await service.fetchNews();
    const cached = await service.fetchNews();
    assert.strictEqual(cached[0].id, 'cached-news');
    assert.strictEqual(service.getMetrics().newsCircuitOpen, true);
  });
});
