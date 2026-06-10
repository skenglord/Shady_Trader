import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import { MarketDataService } from '../../backend/api/marketDataService.js';
import { OptimizationEngine } from '../../backend/strategy/optimization_engine.js';

declare global {
  var __mockRedisAvailable: boolean | undefined;
}

const originalEnv = { ...process.env };

function resetQueueModules() {
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;
  delete process.env.REDIS_PASSWORD;
}

describe('job_queues', () => {
  beforeEach(() => {
    resetQueueModules();
    delete global.__mockRedisAvailable;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('getMarketDataQueue returns null when Redis unavailable', async () => {
    resetQueueModules();
    const { getMarketDataQueue } = await import('../../backend/job_queues.js');
    const queue = getMarketDataQueue();
    assert.strictEqual(queue, null);
  });

  test('getOptimizationQueue returns null when Redis unavailable', async () => {
    resetQueueModules();
    const { getOptimizationQueue } = await import('../../backend/job_queues.js');
    const queue = getOptimizationQueue();
    assert.strictEqual(queue, null);
  });

  test('initializeWorkers handles Redis unavailable gracefully', async () => {
    resetQueueModules();
    const marketDataService = {
      fetchMarketData: async () => ({}),
      fetchNews: async () => []
    } as any;
    const optimizationEngine = { optimize: async () => {} } as any;
    
    const { initializeWorkers } = await import('../../backend/job_queues.js');
    
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = initializeWorkers(marketDataService, optimizationEngine);
    assert.strictEqual(result, undefined);
  });

  test('getQueueHealth returns zero counts when queues unavailable', async () => {
    resetQueueModules();
    const { getQueueHealth } = await import('../../backend/job_queues.js');
    
    await new Promise(resolve => setTimeout(resolve, 100));
    const health = await getQueueHealth();
    
    assert.strictEqual(health?.marketData.waiting, 0);
    assert.strictEqual(health?.optimization.waiting, 0);
    assert.strictEqual(health?.redisAvailable, false);
  });

  test('closeQueues handles null workers gracefully', async () => {
    resetQueueModules();
    const { closeQueues } = await import('../../backend/job_queues.js');
    
    await new Promise(resolve => setTimeout(resolve, 100));
    await closeQueues();
  });

  test('TradingEngine start method starts successfully', async () => {
    resetQueueModules();
    const { TradingEngine } = await import('../../backend/main.js');
    
    const wss = new WebSocketServer({ noServer: true });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    
    MarketDataService.prototype.fetchMarketData = async () => ({
      market_cap: 0, total_volume: 0, fear_greed_index: 50, fear_greed_value: 'Neutral',
      btc_dominance: 0, last_updated: Date.now(), timestamp: Date.now()
    });
    MarketDataService.prototype.fetchNews = async () => [];
    
    await engine.init();
    assert.strictEqual(engine.isRunning, false);
    
    engine.stopSchedulers();
    wss.close();
  });
});