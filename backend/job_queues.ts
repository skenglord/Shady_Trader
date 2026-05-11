import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
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
      lazyConnect: true,
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

// Job queues (lazy initialization)
let marketDataQueue: Queue | null = null;
let optimizationQueue: Queue | null = null;

export function getMarketDataQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!marketDataQueue && conn && redisAvailable) {
    try {
      marketDataQueue = new Queue('market-data', {
        connection: conn,
        defaultJobOptions: {
          priority: 5, // Medium priority for market data
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000
          }
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
          priority: 3, // Lower priority for optimization
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 30000
          }
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

// Data pipeline queue for high-priority data processing
let dataPipelineQueue: Queue | null = null;
let dataPipelineWorker: Worker | null = null;

export function getDataPipelineQueue(): Queue | null {
  const conn = getRedisConnection();
  if (!dataPipelineQueue && conn && redisAvailable) {
    try {
      dataPipelineQueue = new Queue('data-pipeline', {
        connection: conn,
        defaultJobOptions: {
          priority: 10, // High priority for data pipeline
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 1000
          },
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

// Initialize workers (called after services are ready)
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
      const { operation, data } = job.data;

      // Process based on operation type
      switch (operation) {
        case 'indicator_calculation':
          // Handle parallel indicator calculation
          break;
        case 'cache_invalidation':
          // Handle cache invalidation
          break;
        case 'data_deduplication':
          // Handle data deduplication
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
    concurrency: 4, // Higher concurrency for data pipeline
    limiter: { max: 100, duration: 60000 }, // Allow more jobs per minute
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

// Queue monitoring
export async function getQueueHealth() {
  try {
    const mdQueue = getMarketDataQueue();
    const optQueue = getOptimizationQueue();
    const dpQueue = getDataPipelineQueue();

    if (!mdQueue || !optQueue) {
      return {
        marketData: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        optimization: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        dataPipeline: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        timestamp: Date.now(),
        redisAvailable,
      };
    }

    const [marketDataStats, optimizationStats, dataPipelineStats] = await Promise.all([
      mdQueue.getJobCounts(),
      optQueue.getJobCounts(),
      dpQueue ? dpQueue.getJobCounts() : Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    ]);

    return {
      marketData: {
        waiting: marketDataStats.waiting || 0,
        active: marketDataStats.active || 0,
        completed: marketDataStats.completed || 0,
        failed: marketDataStats.failed || 0,
        delayed: marketDataStats.delayed || 0,
      },
      optimization: {
        waiting: optimizationStats.waiting || 0,
        active: optimizationStats.active || 0,
        completed: optimizationStats.completed || 0,
        failed: optimizationStats.failed || 0,
        delayed: optimizationStats.delayed || 0,
      },
      dataPipeline: {
        waiting: dataPipelineStats.waiting || 0,
        active: dataPipelineStats.active || 0,
        completed: dataPipelineStats.completed || 0,
        failed: dataPipelineStats.failed || 0,
        delayed: dataPipelineStats.delayed || 0,
      },
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

// Graceful shutdown
export async function closeQueues() {
  logger.info('Closing job queues', { service: 'JobQueue' });

  const closePromises: Promise<void>[] = [];

  if (marketDataWorker) closePromises.push(marketDataWorker.close().then(() => {}).catch(() => {}));
  if (optimizationWorker) closePromises.push(optimizationWorker.close().then(() => {}).catch(() => {}));
  if (dataPipelineWorker) closePromises.push(dataPipelineWorker.close().then(() => {}).catch(() => {}));
  if (marketDataQueue) closePromises.push(marketDataQueue.close().then(() => {}).catch(() => {}));
  if (optimizationQueue) closePromises.push(optimizationQueue.close().then(() => {}).catch(() => {}));
  if (dataPipelineQueue) closePromises.push(dataPipelineQueue.close().then(() => {}).catch(() => {}));
  if (redisConnection) closePromises.push(redisConnection.quit().then(() => {}).catch(() => {}));

  await Promise.all(closePromises);

  logger.info('Job queues closed successfully', { service: 'JobQueue' });
}