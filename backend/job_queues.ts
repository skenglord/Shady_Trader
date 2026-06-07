import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { existsSync } from 'fs';
import path from 'path';
import { MarketDataService } from './api/marketDataService.js';
import { OptimizationEngine } from './strategy/optimization_engine.js';
import { logger } from './logging/logger.js';

// Redis connection with graceful error handling
let redisConnection: IORedis | null = null;
let redisAvailable = false;
let marketDataWorker: Worker | null = null;
let optimizationWorker: Worker | null = null;
let connectionAttempted = false;

function getRedisConnection(): IORedis | null {
  if (redisConnection) return redisConnection;
  if (connectionAttempted) return null; // Already tried and failed
  connectionAttempted = true;
  
  try {
    redisConnection = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || '',
      maxRetriesPerRequest: null,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    
    redisConnection.on('connect', () => {
      redisAvailable = true;
      logger.info('Redis connection established', { service: 'JobQueue' });
    });
    
    redisConnection.on('error', (err) => {
      redisAvailable = false;
      logger.warn('Redis connection error, queue jobs will be disabled', { 
        error: err.message,
        service: 'JobQueue'
      });
    });
    
    return redisConnection;
  } catch (err) {
    logger.warn('Failed to create Redis connection, queue jobs disabled', { 
      error: err instanceof Error ? err.message : String(err),
      service: 'JobQueue'
    });
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Standard queues (lazy initialization)
// ──────────────────────────────────────────────────────────────────────
let marketDataQueue: Queue | null = null;
let optimizationQueue: Queue | null = null;
let dataPipelineQueue: Queue | null = null;
let dataPipelineWorker: Worker | null = null;

// ──────────────────────────────────────────────────────────────────────
// Freqtrade queues (3.1 — all three serialised at concurrency:1 per B9)
// ──────────────────────────────────────────────────────────────────────
let freqtradeDataQueue: Queue | null = null;
let freqtradeBacktestQueue: Queue | null = null;
let freqtradeValidateQueue: Queue | null = null;
let freqtradeWorkersRegistered = false;
let freqtradeDataWorker: Worker | null = null;
let freqtradeBacktestWorker: Worker | null = null;
let freqtradeValidateWorker: Worker | null = null;

// ──────────────────────────────────────────────────────────────────────
// Standard queue getters
// ──────────────────────────────────────────────────────────────────────

export function getMarketDataQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!marketDataQueue && conn && redisAvailable) {
    try {
      marketDataQueue = new Queue('market-data', {
        connection: conn,
        defaultJobOptions: {
          priority: 5,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 }
        }
      });
    } catch (err) {
      logger.warn('Failed to create market data queue', {
        error: err instanceof Error ? err.message : String(err),
        service: 'JobQueue'
      });
    }
  }
  return marketDataQueue;
}

export function getOptimizationQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!optimizationQueue && conn && redisAvailable) {
    try {
      optimizationQueue = new Queue('optimization', {
        connection: conn,
        defaultJobOptions: {
          priority: 3,
          attempts: 2,
          backoff: { type: 'exponential', delay: 30000 }
        }
      });
    } catch (err) {
      logger.warn('Failed to create optimization queue', {
        error: err instanceof Error ? err.message : String(err),
        service: 'JobQueue'
      });
    }
  }
  return optimizationQueue;
}

export function getDataPipelineQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!dataPipelineQueue && conn && redisAvailable) {
    try {
      dataPipelineQueue = new Queue('data-pipeline', {
        connection: conn,
        defaultJobOptions: {
          priority: 10,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 50,
          removeOnFail: 20
        }
      });
    } catch (err) {
      logger.warn('Failed to create data pipeline queue', {
        error: err instanceof Error ? err.message : String(err),
        service: 'JobQueue'
      });
    }
  }
  return dataPipelineQueue;
}

// ──────────────────────────────────────────────────────────────────────
// Freqtrade queue getters (3.1-3.2)
// ──────────────────────────────────────────────────────────────────────

export function getFreqtradeDataQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!freqtradeDataQueue && conn && redisAvailable) {
    try {
      freqtradeDataQueue = new Queue('freqtrade-data', {
        connection: conn,
        defaultJobOptions: {
          attempts: 1,           // download-data not auto-retried
          removeOnComplete: 20,
          removeOnFail: 10
        }
      });
    } catch (err) {
      logger.warn('Failed to create freqtrade-data queue', {
        error: err instanceof Error ? err.message : String(err),
        service: 'JobQueue'
      });
    }
  }
  return freqtradeDataQueue;
}

export function getFreqtradeBacktestQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!freqtradeBacktestQueue && conn && redisAvailable) {
    try {
      freqtradeBacktestQueue = new Queue('freqtrade-backtest', {
        connection: conn,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: 20,
          removeOnFail: 10
        }
      });
    } catch (err) {
      logger.warn('Failed to create freqtrade-backtest queue', {
        error: err instanceof Error ? err.message : String(err),
        service: 'JobQueue'
      });
    }
  }
  return freqtradeBacktestQueue;
}

export function getFreqtradeValidateQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!freqtradeValidateQueue && conn && redisAvailable) {
    try {
      freqtradeValidateQueue = new Queue('freqtrade-validate', {
        connection: conn,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: 20,
          removeOnFail: 10
        }
      });
    } catch (err) {
      logger.warn('Failed to create freqtrade-validate queue', {
        error: err instanceof Error ? err.message : String(err),
        service: 'JobQueue'
      });
    }
  }
  return freqtradeValidateQueue;
}

// ──────────────────────────────────────────────────────────────────────
// registerFreqtradeWorkers (3.3 + 3.3b)
// Idempotent — safe to call from startSchedulers() on every restart.
// Gates on FREQTRADE_ENABLED=true AND venv presence so the main app
// starts normally even when the sidecar isn't installed.
// ──────────────────────────────────────────────────────────────────────

export async function registerFreqtradeWorkers(): Promise<void> {
  if (freqtradeWorkersRegistered) return; // idempotent guard

  const enabled = process.env.FREQTRADE_ENABLED === 'true';
  if (!enabled) {
    logger.info('FREQTRADE_ENABLED not set — skipping freqtrade worker registration', {
      service: 'JobQueue'
    });
    return;
  }

  // Check venv exists (install_freqtrade.sh must have run first)
  const thisFileDir = path.dirname(new URL(import.meta.url).pathname);
  const venvBin = path.join(thisFileDir, 'freqtrade', 'venv', 'bin', 'freqtrade');
  if (!existsSync(venvBin)) {
    logger.warn('Freqtrade venv not found — run `npm run freqtrade:install` first', {
      service: 'JobQueue',
      venvBin
    });
    return;
  }

  const conn = getRedisConnection();
  if (!conn || !redisAvailable) {
    logger.warn('Redis not available — cannot register freqtrade workers', { service: 'JobQueue' });
    return;
  }

  // Lazy-import workers to avoid hard dep when freqtrade isn't installed
  const { processFreqtradeDataJob } = await import('./freqtrade/workers/dataWorker.js');
  const { processFreqtradeBacktestJob } = await import('./freqtrade/workers/backtestWorker.js');
  const { processFreqtradeValidateJob } = await import('./freqtrade/workers/validateWorker.js');

  const concurrency = parseInt(process.env.FREQTRADE_QUEUE_CONCURRENCY || '1', 10);

  // B9: serialise download + backtest so they don't race on user_data/
  freqtradeDataWorker = new Worker('freqtrade-data', processFreqtradeDataJob, {
    connection: conn,
    concurrency
  });
  freqtradeBacktestWorker = new Worker('freqtrade-backtest', processFreqtradeBacktestJob, {
    connection: conn,
    concurrency
  });
  freqtradeValidateWorker = new Worker('freqtrade-validate', processFreqtradeValidateJob, {
    connection: conn,
    concurrency
  });

  // Error handlers
  for (const [name, worker] of [
    ['freqtrade-data', freqtradeDataWorker],
    ['freqtrade-backtest', freqtradeBacktestWorker],
    ['freqtrade-validate', freqtradeValidateWorker],
  ] as [string, Worker][]) {
    worker.on('failed', (job, err) => {
      logger.error(`${name} job failed`, {
        jobId: job?.id,
        error: err.message,
        attempts: job?.attemptsMade,
        service: 'JobQueue'
      });
    });
  }

  // 3.3b — Weekly cron: Sunday 03:00 UTC (Decision 6 §12)
  const dataQueue = getFreqtradeDataQueue();
  if (dataQueue) {
    try {
      await dataQueue.add(
        'weekly-download',
        {
          jobId: 'cron-weekly',
          exchange: process.env.EXCHANGE_NAME || 'binance',
          pairs: (process.env.FREQTRADE_DEFAULT_PAIRS || 'BTC/USDT,ETH/USDT').split(','),
          timeframes: ['1h', '4h', '1d'],
          tradingMode: (process.env.FREQTRADE_TRADING_MODE || 'spot') as 'spot' | 'futures' | 'margin',
          dataFormat: 'parquet' as const
        },
        {
          repeat: { pattern: '0 3 * * 0' }, // Every Sunday 03:00 UTC
          jobId: 'freqtrade-weekly-download-cron'
        }
      );
      logger.info('Freqtrade weekly download cron registered (Sun 03:00 UTC)', { service: 'JobQueue' });
    } catch (err) {
      logger.warn('Failed to register freqtrade weekly cron', {
        error: err instanceof Error ? err.message : String(err),
        service: 'JobQueue'
      });
    }
  }

  freqtradeWorkersRegistered = true;
  logger.info('Freqtrade BullMQ workers registered', { service: 'JobQueue', concurrency });
}

// ──────────────────────────────────────────────────────────────────────
// Standard worker initialization (called after services are ready)
// ──────────────────────────────────────────────────────────────────────

export function initializeWorkers(marketDataService: MarketDataService, optimizationEngine: OptimizationEngine) {
  const conn = getRedisConnection();
  if (!conn || !redisAvailable) {
    logger.warn('Cannot initialize workers: Redis not available', { service: 'JobQueue' });
    return;
  }

  // Market data worker
  marketDataWorker = new Worker('market-data', async (job) => {
    logger.info('Processing market data job', { jobId: job.id, service: 'JobQueue' });
    try {
      await marketDataService.fetchMarketData();
      await marketDataService.fetchNews();
      logger.info('Market data job completed successfully', { jobId: job.id, service: 'JobQueue' });
    } catch (error) {
      logger.error('Market data job failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
        service: 'JobQueue'
      });
      throw error;
    }
  }, {
    connection: conn,
    concurrency: 1,
    limiter: { max: 1, duration: 60000 },
  });

  // Optimization worker
  optimizationWorker = new Worker('optimization', async (job) => {
    const { currentRegime }: { currentRegime: string } = job.data;
    logger.info('Processing optimization job', { jobId: job.id, regime: currentRegime, service: 'JobQueue' });
    try {
      await optimizationEngine.optimize(currentRegime);
      logger.info('Optimization job completed successfully', { jobId: job.id, service: 'JobQueue' });
    } catch (error) {
      logger.error('Optimization job failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
        service: 'JobQueue'
      });
      throw error;
    }
  }, {
    connection: conn,
    concurrency: 1,
    limiter: { max: 1, duration: 3600000 },
  });

  // Data pipeline worker (high priority)
  dataPipelineWorker = new Worker('data-pipeline', async (job) => {
    logger.info('Processing data pipeline job', { jobId: job.id, priority: job.opts.priority, service: 'JobQueue' });
    try {
      const { operation } = job.data;
      switch (operation) {
        case 'indicator_calculation':
          break;
        case 'cache_invalidation':
          break;
        case 'data_deduplication':
          break;
        default:
          logger.warn('Unknown data pipeline operation', { operation });
      }
      logger.info('Data pipeline job completed successfully', { jobId: job.id, service: 'JobQueue' });
    } catch (error) {
      logger.error('Data pipeline job failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
        service: 'JobQueue'
      });
      throw error;
    }
  }, {
    connection: conn,
    concurrency: 4,
    limiter: { max: 100, duration: 60000 },
  });

  // Worker event handlers
  marketDataWorker.on('failed', (job, err) => {
    logger.error('Market data job failed permanently', {
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade,
      service: 'JobQueue'
    });
  });

  optimizationWorker.on('failed', (job, err) => {
    logger.error('Optimization job failed permanently', {
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade,
      service: 'JobQueue'
    });
  });

  marketDataWorker.on('completed', (job) => {
    logger.info('Market data job completed', { jobId: job.id, service: 'JobQueue' });
  });

  optimizationWorker.on('completed', (job) => {
    logger.info('Optimization job completed', { jobId: job.id, service: 'JobQueue' });
  });

  logger.info('BullMQ workers initialized', { service: 'JobQueue' });
}

// ──────────────────────────────────────────────────────────────────────
// Queue health (3.2 — includes freqtrade queues)
// ──────────────────────────────────────────────────────────────────────

export async function getQueueHealth() {
  try {
    const mdQueue = getMarketDataQueue();
    const optQueue = getOptimizationQueue();
    const dpQueue = getDataPipelineQueue();
    const ftDataQueue = getFreqtradeDataQueue();
    const ftBacktestQueue = getFreqtradeBacktestQueue();
    const ftValidateQueue = getFreqtradeValidateQueue();

    const empty = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

    if (!mdQueue || !optQueue) {
      return {
        marketData: empty,
        optimization: empty,
        dataPipeline: empty,
        freqtradeData: empty,
        freqtradeBacktest: empty,
        freqtradeValidate: empty,
        timestamp: Date.now(),
        redisAvailable,
      };
    }

    const [
      marketDataStats,
      optimizationStats,
      dataPipelineStats,
      ftDataStats,
      ftBacktestStats,
      ftValidateStats
    ] = await Promise.all([
      mdQueue.getJobCounts(),
      optQueue.getJobCounts(),
      dpQueue ? dpQueue.getJobCounts() : Promise.resolve(empty),
      ftDataQueue ? ftDataQueue.getJobCounts() : Promise.resolve(empty),
      ftBacktestQueue ? ftBacktestQueue.getJobCounts() : Promise.resolve(empty),
      ftValidateQueue ? ftValidateQueue.getJobCounts() : Promise.resolve(empty),
    ]);

    const normalise = (s: Record<string, number>) => ({
      waiting: s.waiting || 0,
      active: s.active || 0,
      completed: s.completed || 0,
      failed: s.failed || 0,
      delayed: s.delayed || 0,
    });

    return {
      marketData: normalise(marketDataStats),
      optimization: normalise(optimizationStats),
      dataPipeline: normalise(dataPipelineStats),
      freqtradeData: normalise(ftDataStats),
      freqtradeBacktest: normalise(ftBacktestStats),
      freqtradeValidate: normalise(ftValidateStats),
      timestamp: Date.now(),
      redisAvailable,
    };
  } catch (error) {
    logger.error('Failed to get queue health', {
      error: error instanceof Error ? error.message : String(error),
      service: 'JobQueue'
    });
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────────────────

export async function closeQueues() {
  logger.info('Closing job queues', { service: 'JobQueue' });

  const closePromises: Promise<void>[] = [];

  if (marketDataWorker)       closePromises.push(marketDataWorker.close().then(() => {}).catch(() => {}));
  if (optimizationWorker)     closePromises.push(optimizationWorker.close().then(() => {}).catch(() => {}));
  if (dataPipelineWorker)     closePromises.push(dataPipelineWorker.close().then(() => {}).catch(() => {}));
  if (freqtradeDataWorker)    closePromises.push(freqtradeDataWorker.close().then(() => {}).catch(() => {}));
  if (freqtradeBacktestWorker) closePromises.push(freqtradeBacktestWorker.close().then(() => {}).catch(() => {}));
  if (freqtradeValidateWorker) closePromises.push(freqtradeValidateWorker.close().then(() => {}).catch(() => {}));
  if (marketDataQueue)         closePromises.push(marketDataQueue.close().then(() => {}).catch(() => {}));
  if (optimizationQueue)       closePromises.push(optimizationQueue.close().then(() => {}).catch(() => {}));
  if (dataPipelineQueue)       closePromises.push(dataPipelineQueue.close().then(() => {}).catch(() => {}));
  if (freqtradeDataQueue)      closePromises.push(freqtradeDataQueue.close().then(() => {}).catch(() => {}));
  if (freqtradeBacktestQueue)  closePromises.push(freqtradeBacktestQueue.close().then(() => {}).catch(() => {}));
  if (freqtradeValidateQueue)  closePromises.push(freqtradeValidateQueue.close().then(() => {}).catch(() => {}));
  if (redisConnection)         closePromises.push(redisConnection.quit().then(() => {}).catch(() => {}));

  await Promise.all(closePromises);

  logger.info('Job queues closed successfully', { service: 'JobQueue' });
}