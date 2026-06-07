import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import helmet from "helmet";
import { initDatabase } from "./backend/database.js";
import { runMigrations } from "./backend/migrations/runner.js";
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
import rateLimit from 'express-rate-limit';
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

  // Disable X-Powered-By to avoid leaking server technology
  app.disable('x-powered-by');

  // Security headers via Helmet (CSP, HSTS, X-Frame-Options, etc.)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Required for TradingView charts
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
    },
    // Permissions-Policy: deny powerful browser features the app doesn't use.
    // This is a defense-in-depth measure — even if an XSS slips through, the
    // attacker can't enable camera/mic/geolocation/payment/etc. without an
    // explicit opt-in. The CSP frame-src governs iframes (TradingView widget).
    permittedCrossDomainPolicies: false,
  }));

  // Permissions-Policy is not exposed via helmet() options in all versions, so set
  // it explicitly. This denies camera, microphone, geolocation, payment, USB,
  // accelerometer, gyroscope, magnetometer, ambient-light-sensor, autoplay,
  // encrypted-media, fullscreen (unless user-initiated), and picture-in-picture.
  // The app uses none of these — deny them all.
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', [
      'accelerometer=()',
      'ambient-light-sensor=()',
      'autoplay=()',
      'battery=()',
      'camera=()',
      'display-capture=()',
      'document-domain=()',
      'encrypted-media=()',
      'fullscreen=(self)',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'picture-in-picture=()',
      'publickey-credentials-get=()',
      'screen-wake-lock=()',
      'sync-xhr=()',
      'usb=()',
      'web-share=()',
      'xr-spatial-tracking=()'
    ].join(', '));
    next();
  });

  // Configure CORS — restrict to known origins, never allow credentials with *
  const allowedOrigins = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(',').map(o => o.trim())
    : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      // Allow requests with no Origin header (e.g. server-to-server, curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: Origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-api-token',
      'x-request-id',
      'x-csrf-token'
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
  // SECURITY: Always require a strong session secret from environment.
  // If not set, generate a random one (which means sessions are invalidated on restart).
  const SESSION_SECRET = process.env.SESSION_SECRET
    || (() => {
      const generated = crypto.randomBytes(64).toString('hex');
      if (process.env.NODE_ENV === 'production') {
        logger.error('SESSION_SECRET not set in production — using random ephemeral secret. Sessions will be invalidated on restart. Set SESSION_SECRET env var to persist sessions.');
      } else {
        logger.warn('SESSION_SECRET not set — using random ephemeral secret. Sessions will be invalidated on restart.');
      }
      return generated;
    })();

  app.use(session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 3600000, // 1 hour
    },
    name: 'shady.sid'
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Custom error handlers — prevent leaking server internals (file paths, stack traces)
  // Must run BEFORE the request logger so the JSON parse failure doesn't reach the
  // default Express HTML error page (which would expose absolute server paths).
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'Request entity too large',
        message: 'Request body must be less than 10MB'
      });
    }
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      logger.warn('Malformed JSON body received', {
        requestId: (req as any).requestId,
        route: req.originalUrl || req.url,
        method: req.method
      });
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    next(err);
  });

  // Final error handler — catch-all for any remaining errors. Returns JSON, not HTML,
  // and never leaks stack traces or file paths. Detailed error info is logged server-side.
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error('Unhandled request error', {
      requestId: (req as any).requestId,
      route: req.originalUrl || req.url,
      method: req.method,
      error: err?.message,
      // Intentionally do NOT include err.stack in the response
    });
    if (res.headersSent) {
      return next(err);
    }
    res.status(err.status || 500).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err?.message || 'Internal server error')
    });
  });

  app.use((req, res, next) => {
    console.log('Request:', req.method, req.url);
    next();
  });

   // Initialize database
   await initDatabase();

   // Run schema migrations (idempotent) before seeding
   try {
     await runMigrations();
   } catch (error: any) {
     logger.warn('Migrations encountered an issue', { error: error?.message || 'unknown' });
   }
   
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

  // Rate limiting for API routes — protect against abuse.
  // Production: 120 req/min per IP (legitimate use shouldn't exceed this).
  // Development: 600 req/min per IP to accommodate browser QA harnesses and
  //   rapid polling by the live confidence/regime/signal WebSocket clients.
  const isDev = process.env.NODE_ENV !== 'production';
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: isDev ? 600 : 120, // dev: 10 RPS, prod: 2 RPS
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
  });

  // Prometheus metrics endpoint — restrict to localhost in all environments.
  // The metrics include process internals (memory, CPU, file descriptors, event
  // loop lag) that an attacker can use to fingerprint the server, plan timing
  // attacks, or correlate request volume with internal state. The endpoint is
  // intended for local monitoring scrapers (Prometheus, etc.) — for remote
  // monitoring, use the trader-protected /api/diagnostics/metrics endpoint.
  app.get('/metrics', async (req, res) => {
    const remoteAddr = req.ip || req.socket.remoteAddress || '';
    const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
    if (!isLocalhost) {
      logger.warn('Blocked /metrics access from non-localhost', { remoteAddr });
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (ex) {
      res.status(500).end(ex);
    }
  });

  // API routes — mount with rate limiter
  app.use("/api", apiLimiter, (req, res, next) => {
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
  
  // Setup WebSocket with token-based auth (defense-in-depth: never accept anonymous
  // connections to a trading data broadcast). The token is passed as a query string
  // parameter, validated against the same API_ADMIN_TOKEN / API_TRADER_TOKEN used
  // for the REST API. The role is stashed on the upgrade request so the connection
  // handler in backend/api/websocket.ts can tag the client for downstream filtering.
  const getWsAuthTokens = () => ({
    adminToken: process.env.API_ADMIN_TOKEN || process.env.API_AUTH_TOKEN || '',
    traderToken: process.env.API_TRADER_TOKEN || ''
  });
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      try {
        const url = new URL(info.req.url || '/', `http://${info.req.headers.host || 'localhost'}`);
        const token = url.searchParams.get('token');
        if (!token) {
          logger.warn('WebSocket connection rejected: no token', {
            remoteAddr: info.req.socket.remoteAddress
          });
          return done(false, 401, 'Unauthorized');
        }
        const { adminToken, traderToken } = getWsAuthTokens();
        // If no tokens are configured server-side, reject the connection (fail closed).
        if (!adminToken && !traderToken) {
          logger.warn('WebSocket connection rejected: API tokens not configured server-side', {
            remoteAddr: info.req.socket.remoteAddress
          });
          return done(false, 503, 'Auth not configured');
        }
        let role: 'admin' | 'trader' | null = null;
        if (adminToken && token === adminToken) role = 'admin';
        else if (traderToken && token === traderToken) role = 'trader';
        if (!role) {
          logger.warn('WebSocket connection rejected: invalid token', {
            remoteAddr: info.req.socket.remoteAddress
          });
          return done(false, 401, 'Unauthorized');
        }
        (info.req as any).wsRole = role;
        done(true);
      } catch (err) {
        logger.error('WebSocket verifyClient error', { error: (err as Error).message });
        done(false, 500, 'Internal error');
      }
    }
  });
  setupWebsocket(wss);

  // Start trading engine
  startTradingEngine(wss, redis);

  // Vite middleware for development
  // Top-level deny-list for project files that should never be served to the
  // network. Used in both dev (Vite) and prod (express.static + SPA fallback)
  // branches below.
  const deniedPrefixes = [
    '/backend/',
    '/cli/',
    '/scripts/',
    '/src/backend/',
    '/coverage/',
    '/test-results/',
    '/playwright-report/',
    '/backups/',
    '/logs/',
    '/uploads/',
    '/data/',
    '/.git/',
    '/.kilo/',
    '/.hermes/',
    // Vite dev needs to serve its own dep cache and client runtime; blocking
    // /node_modules/ wholesale causes 404s on /node_modules/.vite/deps/*.js
    // and /node_modules/vite/dist/client/env.mjs, which prevent the React
    // app from bootstrapping in dev mode. We instead block the specific
    // project-installed packages whose source should never be served
    // (e.g. typosquatting a request like /node_modules/typescript/lib/...).
    '/node_modules/typescript/',
    '/node_modules/.bin/',
    // Test/build artifacts under node_modules
    '/node_modules/.cache/',
    '/tests/',
    '/docs/',
    '/documentation/',
    '/k8s/',
    '/docker/',
    '/qa-output',
  ];
  const deniedExact = new Set([
    '/package.json',
    '/package-lock.json',
    '/tsconfig.json',
    '/tsconfig.node.json',
    '/vite.config.ts',
    '/server.ts',
    '/server-clean.log',
    '/server-clean2.log',
    '/server-final.log',
    '/server.pid',
    '/seed.ts',
    '/.env',
    '/.env.example',
    '/.env.development.local',
    '/.env.production',
    '/playwright.config.ts',
    '/.gitignore',
    '/.dockerignore',
    '/AGENTS.md',
    '/CLAUDE.md',
    '/CHANGES.md',
    '/CODEBASE_STRUCTURE.md',
    '/SYSTEM_DATA_ANALYSIS.md',
    '/test_audit_report.md',
    '/build_logic.md',
    '/README.md',
    '/COMPONENT_READINESS_MATRIX.md',
    '/cli-smoke-output.txt',
    '/docker-compose.yml',
    '/Dockerfile',
    '/test-db.js',
    '/helm.tar.gz',
    '/Bitcoin Historical Data.html',
    '/comparecryptoapi.pdf',
    '/metadata.json',
    '/highlights.json',
  ]);
  const createSourceDenyMiddleware = (): express.RequestHandler => (req, res, next) => {
    const p = req.path;
    // Only guard GET/HEAD — POST/PUT/DELETE are not Vite/static-served.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (deniedExact.has(p)) {
      return res.status(404).json({ error: 'Not Found' });
    }
    for (const prefix of deniedPrefixes) {
      if (p === prefix.slice(0, -1) || p.startsWith(prefix)) {
        return res.status(404).json({ error: 'Not Found' });
      }
    }
    next();
  };

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    // Source-deny middleware runs BEFORE Vite so /package.json, /server.ts, and
    // /backend/**/*.ts never reach the Vite static file server (which would
    // happily return them as TS source in dev mode).
    app.use(createSourceDenyMiddleware());

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    // Source-deny middleware also runs before the SPA fallback so /package.json,
    // /server.ts, /.env, /AGENTS.md, etc. return 404 instead of being rewritten
    // to index.html (which would expose a 200 + HTML response that React would
    // try to render as a route).
    app.use(createSourceDenyMiddleware());
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Default to 127.0.0.1 (localhost only) for security. Set HOST=0.0.0.0 to bind to
  // all interfaces (e.g. for LAN access in a trusted dev environment). The dev server
  // bundles Vite, the Vite deny-list is enabled, and the /metrics endpoint is
  // localhost-restricted — but binding to all interfaces would still expose those
  // endpoints to anyone who can reach the port, so this remains opt-in.
  const HOST = process.env.HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
      logger.warn('Server bound to 0.0.0.0 — exposed on all network interfaces', { service: 'server' });
    }
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
