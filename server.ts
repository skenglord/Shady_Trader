import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import cors from "cors";
import { initDatabase } from "./backend/database.js";
import { startTradingEngine } from "./backend/main.js";
import { setupWebsocket } from "./backend/api/websocket.js";
import { apiRouter } from "./backend/api/routes.js";
import { seedDatabase } from "./seed.js";
import { performBackup } from "./backend/backup.js";
import { envSchema } from './backend/config/validation.js';
import { logger } from './backend/logging/logger.js';
import { register, collectDefaultMetrics, Gauge, Counter, Histogram } from 'prom-client';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import Redis from 'ioredis';

// Initialize OpenTelemetry
const sdk = new NodeSDK({
  serviceName: 'shady-trader',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTLP_ENDPOINT || 'http://localhost:4317'
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});
try {
  sdk.start();
} catch (e) {
  logger.warn('OpenTelemetry initialization failed', { error: e instanceof Error ? e.message : String(e) });
}

async function startServer() {
  // Validate environment variables
  const envResult = envSchema.safeParse(process.env);
  if (!envResult.success) {
    console.error('Environment validation failed:', envResult.error.errors);
    logger.error('Environment validation failed', {
      errors: envResult.error.errors
    });
    process.exit(1);
  }
  
  const env = envResult.data;
  logger.info('Environment validation passed', { nodeEnv: env.NODE_ENV });

  // Prometheus metrics
  collectDefaultMetrics();
  const tradingOperationsTotal = new Counter({
    name: 'trading_operations_total',
    help: 'Total number of trading operations performed',
    labelNames: ['type', 'regime']
  });
  const marketDataFetchDuration = new Histogram({
    name: 'market_data_fetch_duration_seconds',
    help: 'Duration of market data fetch operations',
    buckets: [0.1, 0.5, 1, 2, 5]
  });
  const balanceChanges = new Gauge({
    name: 'balance_changes',
    help: 'Current balance changes in trading account'
  });

  const app = express();
  const PORT = env.PORT;

  // Configure CORS
  const corsOptions: cors.CorsOptions = {
    origin: env.CORS_ORIGIN 
      ? env.CORS_ORIGIN.split(',')
      : ['http://localhost:3000', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-api-token',
      'x-request-id'
    ],
    credentials: true,
    maxAge: 86400 // 24 hours
  };
  
  app.use(cors(corsOptions));

  // Redis setup for sessions and state management
  let redis: Redis | null = null;
  let sessionStore: RedisStore | undefined;
  try {
    const redisInstance = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || '',
      connectTimeout: 2000,
      retryStrategy: () => null, // Don't retry
    });
    // Test connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Redis connection timeout')), 2000);
      redisInstance.on('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      redisInstance.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    redis = redisInstance;
    // Session store
    sessionStore = new RedisStore({
      client: redis,
      prefix: 'session:',
      ttl: 3600, // 1 hour
    });
    logger.info('Redis connected successfully', { service: 'server' });
  } catch (error: any) {
    logger.warn('Redis unavailable, using memory store', { error: error.message, service: 'server' });
  }

  // Session middleware
  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'shady-trader-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 3600000, // 1 hour
    },
    name: 'shady.sid'
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Custom 413 handler for oversized requests
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'Request entity too large',
        message: 'Request body must be less than 10MB'
      });
    }
    next(err);
  });

  app.use((req, res, next) => {
    console.log('Request:', req.method, req.url);
    next();
  });

   // Initialize database
   await initDatabase();
   
   // Seed database with mock data (best-effort, do not crash startup)
   try {
     await seedDatabase();
   } catch (error: any) {
     logger.warn('Database seed skipped due to unavailable schema', {
       error: error?.message || 'unknown'
     });
   }

  // Schedule daily backup
  performBackup(); // Run once on startup
  setInterval(performBackup, 24 * 60 * 60 * 1000); // Daily backup

  // Prometheus metrics endpoint
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (ex) {
      res.status(500).end(ex);
    }
  });

  // API routes
  app.use("/api", (req, res, next) => {
    console.log('API route hit:', req.url);
    next();
  }, apiRouter);

  const server = createServer(app);
  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error('HTTP server failed to start', {
      code: error.code,
      message: error.message,
      port: PORT
    });
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Set PORT to a free value and retry.`);
    }
    process.exit(1);
  });
  
  // Setup WebSocket with sticky session support for load balancing
  const wss = new WebSocketServer({ 
    server,
    // Support sticky sessions for multi-instance deployments
    // Client can send X-Forwarded-For header which can be used for routing
    verifyClient: (info, done) => {
      done(true);
    }
  });
  setupWebsocket(wss);

  // Start trading engine
  startTradingEngine(wss, redis);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  logger.error('Uncaught Exception in server', { error: error.message, stack: error.stack });
  // Exit with non-zero to signal crash but don't exit immediately to allow logging
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  logger.error('Unhandled Promise Rejection', { reason: String(reason) });
});

startServer();
