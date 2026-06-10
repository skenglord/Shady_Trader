import { Router } from 'express';
import Redis from 'ioredis';
import crypto from 'crypto';
import { runQuery } from '../database.js';
import { getTradingEngine, getStartupDiagnostics } from '../main.js';
import { RiskMode, DEFAULT_RISK_CONFIGS } from '../risk/manager.js';
import { RegimeType } from '../regime/detector.js';
import { normalizeRegime, isCanonicalRegime, LEGACY_TO_CANONICAL } from '../types/regime.js';
import multer from 'multer';
import { parse } from 'csv-parse';
import fs from 'fs';

const upload = multer({ dest: 'uploads/' });
import { z } from 'zod';
import { getRequestId, logger } from '../logging/logger.js';
import axios from 'axios';
import paperTradingRouter from '../paper-trading/paper-trading.controller.js';
import { recordApiRequest, getApiMetricsSnapshot, toPrometheusMetrics } from '../observability/requestMetrics.js';
import { getMLHealth } from '../ml/index.js';
import { 
  getFreqtradeDataQueue, 
  getFreqtradeBacktestQueue, 
  getFreqtradeValidateQueue 
} from '../job_queues.js';
import { FreqtradeBridge } from '../freqtrade/bridge.js';
import { spawn } from 'child_process';
import path from 'path';
import { freqtradeMetricsRegistry } from '../observability/freqtrade_metrics.js';

// Fallback function to fetch historical data from CoinGecko
async function fetchCoinGeckoHistoricalData(symbol: string, timeframe: string, days: number) {
  try {
    // Map symbol to CoinGecko ID
    const coinId = symbol === 'BTC/USDT' ? 'bitcoin' : symbol === 'ETH/USDT' ? 'ethereum' : 'bitcoin';

    // Map timeframe to CoinGecko days parameter
    let cgDays = '365';
    if (days === 30) cgDays = '30';
    else if (days === 7) cgDays = '7';
    else if (days === 1) cgDays = '1';

    const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`, {
      params: {
        vs_currency: 'usd',
        days: cgDays
      },
      timeout: 10000
    });

    if (response.data && Array.isArray(response.data)) {
      // Convert CoinGecko OHLC format [timestamp, open, high, low, close] to our format
      const candles = response.data.map((ohlc: number[]) => ({
        time: ohlc[0],
        open: ohlc[1],
        high: ohlc[2],
        low: ohlc[3],
        close: ohlc[4],
        volume: 0 // CoinGecko free tier doesn't provide volume
      }));

      // Sort by time ascending
      candles.sort((a, b) => a.time - b.time);

      // Resample to requested timeframe if needed
      if (timeframe !== '1d') {
        // For now, return daily data. Could implement resampling later
        return candles;
      }

      return candles;
    }

    return null;
  } catch (error: any) {
    logger.error('CoinGecko historical data fetch failed', { error: error.message, symbol, timeframe, days });
    return null;
  }
}

export const apiRouter = Router();

// Redis instance for idempotency
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || '',
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    // Initiate connection eagerly so .ping() in /api/diagnostics/health resolves quickly
    redis.connect().catch(() => { /* logged via 'error' handler above */ });
    redis.on('error', (error) => {
      logger.warn('Idempotency Redis unavailable', { error: error?.message || 'unknown' });
    });
  }
  return redis;
}

// Idempotency middleware
function idempotencyKey(required = false) {
  return async (req: any, res: any, next: any) => {
    const idempotencyKey = req.headers['idempotency-key'];

    if (required && !idempotencyKey) {
      return res.status(400).json({
        error: 'Idempotency key required',
        message: 'This endpoint requires an Idempotency-Key header'
      });
    }

    if (idempotencyKey) {
      // Validate key format (should be UUID-like)
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(idempotencyKey)) {
        return res.status(400).json({
          error: 'Invalid idempotency key',
          message: 'Idempotency-Key must be a valid UUID'
        });
      }

      // Create request fingerprint for deduplication
      const requestFingerprint = crypto
        .createHash('sha256')
        .update(`${req.method}:${req.originalUrl}:${JSON.stringify(req.body)}`)
        .digest('hex');

      const cacheKey = `idempotency:${idempotencyKey}:${requestFingerprint}`;

      try {
        const redis = getRedis();
        const cachedResponse = await redis.get(cacheKey);

        if (cachedResponse) {
          const parsed = JSON.parse(cachedResponse);
          return res.status(parsed.statusCode).json(parsed.body);
        }

        // Store request context for deduplication
        req.idempotencyKey = idempotencyKey;
        req.cacheKey = cacheKey;

      } catch (error) {
        logger.error('Idempotency check failed', { error: error.message });
        // Continue without idempotency if Redis fails
      }
    }

    next();
  };
}

// Response caching middleware for idempotent responses
function cacheIdempotentResponse() {
  return (req: any, res: any, next: any) => {
    const originalJson = res.json;
    const originalStatus = res.status;

    res.status = function(code: number) {
      res.statusCode = code;
      return originalStatus.call(this, code);
    };

    res.json = function(body: any) {
      if (req.cacheKey && res.statusCode < 400) {
        // Cache successful responses for idempotency
        const responseData = {
          statusCode: res.statusCode,
          body,
          timestamp: Date.now()
        };

        try {
          const redis = getRedis();
          redis.setex(req.cacheKey, 3600, JSON.stringify(responseData)); // 1 hour TTL
        } catch (error) {
          logger.error('Failed to cache idempotent response', { error: error.message });
        }
      }

      return originalJson.call(this, body);
    };

    next();
  };
}
type Role = 'trader' | 'admin';

const TIMEFRAME_ALLOWLIST = new Set(['1m', '5m', '15m', '1h', '1d']);
const MUTABLE_SETTINGS_BLOCKLIST = new Set(['apiKey', 'apiSecret', 'apiPassword', 'exchange', 'apiProviders']);
const riskModes = new Set(Object.values(RiskMode));
const regimeModes = new Set(Object.values(RegimeType));
const roleRank: Record<Role, number> = { trader: 1, admin: 2 };

function getAuthTokens() {
  const adminToken = process.env.API_ADMIN_TOKEN || process.env.API_AUTH_TOKEN || '';
  const traderToken = process.env.API_TRADER_TOKEN || '';
  return { adminToken, traderToken };
}

function getProvidedToken(req: any) {
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers['x-api-token'];
  return bearerToken || headerToken || '';
}

function resolveRoleFromToken(token: string): Role | null {
  if (!token) return null;
  const { adminToken, traderToken } = getAuthTokens();
  if (adminToken && token === adminToken) return 'admin';
  if (traderToken && token === traderToken) return 'trader';
  return null;
}

function requireRole(requiredRole: Role) {
  return (req: any, res: any, next: any) => {
    const { adminToken, traderToken } = getAuthTokens();
    const isAuthConfigured = Boolean(adminToken || traderToken);
    if (!isAuthConfigured) {
      // SECURITY: Always require auth, even in development.
      // Use API_ADMIN_TOKEN and API_TRADER_TOKEN env vars to configure.
      // Generate with: openssl rand -hex 32
      return res.status(503).json({
        error: 'API authentication is not configured',
        hint: 'Set API_ADMIN_TOKEN and API_TRADER_TOKEN environment variables'
      });
    }

    const providedToken = getProvidedToken(req);
    const callerRole = resolveRoleFromToken(providedToken);
    if (!callerRole) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (roleRank[callerRole] < roleRank[requiredRole]) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// Public routes that don't require authentication.
// IMPORTANT: this list is documentation-only — the actual auth bypass works
// by NOT including these prefixes in `adminRoutes` / `traderRoutes` below.
// (PUBLIC_ROUTES is a near-duplicate of /health/live + /health/ready for
// grep-ability; do not add a route here without also removing its prefix
// from the protected lists.)
const PUBLIC_ROUTES = [
  '/health/live',
  '/health/ready',
  '/health/quick',  // Minimal public liveness probe (replaces /diagnostics/health as the public probe)
  '/status',        // Public status endpoint (correlation ID probe)
];

// Admin-only routes (sensitive operations)
const adminRoutes = [
  '/start',
  '/stop',
  '/optimize',
  '/settings',
  '/risk-configs',
  '/risk-configs/reset',
  '/risk-configs/ai-recommend',
  '/backtest',
  '/kill',
  '/import-csv',
  // Note: /diagnostics is intentionally NOT admin-only here so the
  // /diagnostics/health and /diagnostics/startup endpoints remain public
  // for liveness probes (browser harness, scripts, CI). Admin-only diagnostics
  // is enforced at the individual route level instead.
  '/ml/status',
  '/ml/accuracy',
  '/ml/predictions',
  // Freqtrade admin routes
  '/freqtrade/download-data',
  '/freqtrade/backtest',
  '/freqtrade/validate',
  '/freqtrade/ingest',
];

// Trader routes (view + moderate operations)
const traderRoutes = [
  '/timeframe',
  '/market/refresh',
  '/market/data',
  '/positions',
  '/positions/close',
  '/positions/update',
  '/balances',
  '/balances/allocate',
  '/balances/withdraw',
  '/balances/half',
  '/balances/double',
  '/active-mode',
  '/regime/manual',
  '/regime',
  '/manual-trade',
  '/signals',
  '/closed',
  '/shadow-trades',
  '/trades',
  '/data',
  '/news',
  '/slippage',
  '/health',
  // Diagnostics: protected behind trader auth because the full health/startup
  // response leaks exchange config, slowest routes with latencies, and other
  // internal performance data. Liveness probes should use /api/health/quick or
  // /api/health/live (both public, both return only a minimal status).
  '/diagnostics',
  // Freqtrade trader routes
  '/freqtrade/pairs',
  '/freqtrade/info',
  '/freqtrade/jobs',
];

function validateBody(schema: z.ZodTypeAny) {
  return (req: any, res: any, next: any) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('Payload validation failed', {
        requestId: req.requestId,
        route: req.originalUrl || req.url,
        method: req.method,
        issue: parsed.error.issues[0]?.message
      });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid request payload'
      });
    }
    req.body = parsed.data;
    next();
  };
}

// Health check endpoints
apiRouter.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// Minimal public liveness probe — returns only a status flag and uptime.
// Use this for K8s liveness/readiness probes, browser harness health checks,
// and external monitoring that doesn't need full internal metrics.
// For detailed diagnostics (slowest routes, exchange config, market data, ML
// status), use the trader-protected /api/diagnostics/health endpoint.
apiRouter.get('/health/quick', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSec: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

apiRouter.get('/health/ready', async (req, res) => {
  try {
    // Check database connectivity
    await runQuery('SELECT 1', [], 'run');

    // Check trading engine status
    const engine = getTradingEngine();
    if (!engine) {
      return res.status(503).json({ status: 'not ready', reason: 'Trading engine not initialized' });
    }

    let redisStatus: 'ok' | 'degraded' = 'ok';
    try {
      const redis = getRedis();
      await redis.ping();
    } catch {
      redisStatus = 'degraded';
    }

    res.status(200).json({
      status: 'ready',
      timestamp: Date.now(),
      components: {
        database: 'ok',
        redis: redisStatus,
        tradingEngine: 'ok'
      }
    });
  } catch (error) {
    logger.error('Readiness check failed', { error: error.message });
    res.status(503).json({
      status: 'not ready',
      reason: error.message,
      timestamp: Date.now()
    });
  }
});

apiRouter.use((req, res, next) => {
  const start = process.hrtime.bigint();
  req.requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  res.setHeader('x-request-id', req.requestId);
  logger.info('API request received', {
    requestId: req.requestId,
    route: req.originalUrl || req.url,
    method: req.method
  });
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const routeKey = `${req.method} ${req.route?.path || req.path || req.originalUrl || req.url}`;
    recordApiRequest(routeKey, req.method, res.statusCode, durationMs);
    if (res.statusCode >= 500 || durationMs >= 1000) {
      logger.warn('API request completed with warning', {
        requestId: req.requestId,
        route: routeKey,
        statusCode: res.statusCode,
        latencyMs: Number(durationMs.toFixed(2))
      });
    }
  });
  next();
});

// adminRoutes and traderRoutes are defined above with expanded coverage.
// Track which routes have been protected
const protectedRoutes = new Set<string>();

// JSON 405 catch-all for POST-only routes — must run BEFORE the auth
// middleware so that GET /api/active-mode (or other unsupported method)
// returns 405 Method Not Allowed with an `allow: POST` header, instead of
// the misleading 401 Unauthorized that the auth middleware would otherwise
// emit. Without this, the browser harness and CLI smoketest would log 401s
// for paths that are simply the wrong HTTP method.
const POST_ONLY_ROUTES: Array<{ path: string; allow: string }> = [
  { path: '/active-mode', allow: 'POST' },
  { path: '/regime/manual', allow: 'POST' },
  { path: '/market/refresh', allow: 'POST' },
];
for (const { path, allow } of POST_ONLY_ROUTES) {
  apiRouter.all(path, (req: any, res: any, next: any) => {
    if (req.method === 'POST') return next();           // let the real handler run
    if (req.method === 'OPTIONS') return res.setHeader('allow', allow).status(204).end();
    return res.setHeader('allow', allow).status(405).json({
      error: 'Method Not Allowed',
      route: req.originalUrl || req.url,
      method: req.method,
      requestId: req.requestId,
      allow,
      hint: `This endpoint only accepts ${allow} requests. See backend/api/routes.ts.`
    });
  });
}

for (const route of adminRoutes) {
  apiRouter.use(route, requireRole('admin'));
  protectedRoutes.add(route);
}
for (const route of traderRoutes) {
  apiRouter.use(route, requireRole('trader'));
  protectedRoutes.add(route);
}

// CSRF protection middleware — applied to state-changing routes
function csrfProtection(req: any, res: any, next: any) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  const token = req.headers['x-csrf-token'];
  const sessionToken = req.session?.csrfToken;
  // For API token auth, CSRF is less critical (CORS + token auth mitigates it)
  // But for session auth, require a matching CSRF token
  if (req.headers.authorization?.startsWith('Bearer ') || req.headers['x-api-token']) {
    return next(); // API token auth is not vulnerable to CSRF
  }
  if (!token || !sessionToken || token !== sessionToken) {
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }
  next();
}

// CSRF token endpoint — returns a token for session-based clients
apiRouter.get('/csrf-token', (req: any, res: any) => {
  const token = crypto.randomBytes(32).toString('hex');
  if (req.session) {
    req.session.csrfToken = token;
  }
  res.json({ csrfToken: token });
});

// Apply CSRF protection to state-changing operations
apiRouter.use(csrfProtection);

const timeframeSchema = z.object({
  timeframe: z.string().refine((v) => TIMEFRAME_ALLOWLIST.has(v), 'Invalid timeframe. Allowed: 1m, 5m, 15m, 1h, 1d')
});
const validateTimeframeBody = validateBody(timeframeSchema);

const settingsSchema = z.record(z.any()).superRefine((settings, ctx) => {
  for (const key of Object.keys(settings)) {
    if (MUTABLE_SETTINGS_BLOCKLIST.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Setting "${key}" cannot be modified via this endpoint`
      });
    }
  }
});
const validateSettingsBody = validateBody(settingsSchema);

const validatePositionsCloseBody = validateBody(z.object({
  tradeId: z.string().trim().min(1, 'tradeId is required'),
  currentPrice: z.number().positive('currentPrice must be a positive number')
}));

const validatePositionsUpdateBody = validateBody(z.object({
  tradeId: z.string().trim().min(1, 'tradeId is required'),
  stopLoss: z.number().positive('stopLoss must be a positive number').optional(),
  takeProfit: z.number().positive('takeProfit must be a positive number').optional()
}).refine((v) => v.stopLoss !== undefined || v.takeProfit !== undefined, {
  message: 'At least one of stopLoss or takeProfit must be provided'
}));

const validateRiskConfigsBody = validateBody(z.record(z.any()));

const validateBacktestBody = validateBody(z.object({
  mode: z.string().refine((v) => riskModes.has(v as RiskMode), 'Invalid backtest mode'),
  config: z.record(z.any()),
  startTime: z.number().finite(),
  endTime: z.number().finite()
}).refine((v) => v.endTime > v.startTime, { message: 'Invalid time range' }));

const validateAmountBody = validateBody(z.object({
  amount: z.number().positive('amount must be a positive number')
}));

const validateActiveModeBody = validateBody(z.object({
  mode: z.string().refine((v) => riskModes.has(v as RiskMode), 'Invalid risk mode')
}));

const validateManualRegimeBody = validateBody(z.object({
  regime: z.string().refine(
    (v) => Object.prototype.hasOwnProperty.call(LEGACY_TO_CANONICAL, v),
    'Invalid regime'
  )
}));

const validateManualTradeBody = validateBody(z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string().trim().min(1, 'symbol is required'),
  price: z.number().positive('price must be a positive number'),
  stopLoss: z.number().positive('stopLoss must be a positive number'),
  takeProfit: z.number().positive('takeProfit must be a positive number')
}));

// ──────────────────────────────────────────────────────────────────────
// Freqtrade API Zod Schemas (Phase 4)
// ──────────────────────────────────────────────────────────────────────
const validateFreqtradeDownloadBody = validateBody(z.object({
  exchange: z.string().min(1),
  pairs: z.array(z.string().min(1)).min(1),
  timeframes: z.array(z.string().min(1)).min(1),
  timerange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
  tradingMode: z.enum(['spot', 'futures', 'margin']),
  dataFormat: z.enum(['json', 'feather', 'parquet']),
}));

const validateFreqtradeBacktestBody = validateBody(z.object({
  strategy: z.string().min(1),
  timerange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
  pairs: z.array(z.string().min(1)).min(1),
  timeframe: z.string().min(1),
  dryRunWallet: z.number().positive(),
  fee: z.number().nonnegative().optional(),
}));

const validateFreqtradeValidateBody = validateBody(z.object({
  symbol: z.string().min(1),
  timerange: z.object({ start: z.string(), end: z.string() }),
  strategy: z.string().min(1),
  mode: z.string().min(1),
  pairs: z.array(z.string().min(1)).min(1),
  timeframe: z.string().min(1),
  dryRunWallet: z.number().positive(),
  tolerance: z.number().positive().default(0.05),
}));

apiRouter.get('/status', (req, res) => {
  const engine = getTradingEngine();
  res.json({
    isRunning: engine?.isRunning || false,
    currentRegime: engine?.currentRegime || 'uncertain',
    symbol: engine?.symbol || 'BTC/USDT',
    timeframe: engine?.timeframe || '15m',
    exchange: engine?.exchange?.exchangeName || (engine as any)?.startupDiagnostics?.exchangeName || 'unknown'
  });
});

apiRouter.get('/diagnostics/startup', (req, res) => {
  const diagnostics = getStartupDiagnostics();
  if (!diagnostics) {
    return res.status(500).json({ error: 'Engine not initialized' });
  }
  return res.json(diagnostics);
});

apiRouter.get('/diagnostics/health', async (req, res) => {
  const engine = getTradingEngine();
  if (!engine) {
    return res.status(500).json({ error: 'Engine not initialized' });
  }

  const latestMarketData = await engine.marketDataService.getLatestMarketData();
  const marketMetrics = engine.marketDataService.getMetrics();
  const apiMetrics = getApiMetricsSnapshot();
  let redisStatus: 'ok' | 'degraded' = 'ok';
  try {
    await getRedis().ping();
  } catch {
    redisStatus = 'degraded';
  }
  return res.json({
    uptimeSec: Math.floor(process.uptime()),
    requestId: req.requestId,
    isRunning: engine.isRunning,
    startup: engine.getStartupDiagnostics(),
    infrastructure: {
      redis: redisStatus
    },
    api: apiMetrics,
    marketData: {
      hasCachedData: Boolean(latestMarketData),
      lastUpdated: latestMarketData?.last_updated || null,
      metrics: marketMetrics
    },
    ml: await getMLHealth().catch(() => ({
      enabled: false, modelsReady: false, gemmaCache: false, modelCount: 0
    }))
  });
});

apiRouter.get('/diagnostics/metrics', async (req, res) => {
  const engine = getTradingEngine();
  if (!engine) {
    return res.status(500).json({ error: 'Engine not initialized' });
  }

  const marketMetrics = engine.marketDataService.getMetrics();
  const basePayload = toPrometheusMetrics(marketMetrics);
  
  try {
    const freqtradePayload = await freqtradeMetricsRegistry.metrics();
    const payload = basePayload + '\n' + freqtradePayload;
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(payload);
  } catch (error) {
    logger.warn('Failed to append Freqtrade metrics', { error: error instanceof Error ? error.message : String(error) });
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(basePayload);
  }
});

// ML endpoints (admin-protected)
apiRouter.get('/ml/status', async (req, res) => {
  const models = await runQuery(
    `SELECT symbol, regime, accuracy, drift_score, training_rows,
            trained_at, last_drift_check, is_active
     FROM ml_models
     WHERE is_active = 1
     ORDER BY symbol, regime`
  );
  res.json({
    ml_enabled: process.env.ML_ENABLED === 'true',
    models,
    confidence_threshold: process.env.ML_CONFIDENCE_THRESHOLD
  });
});

apiRouter.get('/ml/accuracy', async (req, res) => {
  const symbol = (req.query.symbol as string) || 'BTC/USDT';
  const days = (req.query.days as string) || '7';
  const accuracy = await runQuery(
    `SELECT
       regime,
       COUNT(*) as total,
       SUM(was_correct) as correct,
       ROUND(AVG(was_correct)*100, 1) as accuracy_pct,
       ROUND(AVG(ABS(xgb_probability - 0.5)), 3) as avg_confidence,
       ROUND(AVG(gemma_adjustment), 3) as avg_gemma_adj
     FROM ml_predictions
     WHERE symbol = ?
       AND actual_direction IS NOT NULL
       AND created_at > datetime('now', ? || ' days')
     GROUP BY regime`,
    [symbol, `-${days}`]
  );
  res.json(accuracy);
});

apiRouter.get('/ml/predictions', async (req, res) => {
  const symbol = (req.query.symbol as string) || 'BTC/USDT';
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const predictions = await runQuery(
    `SELECT * FROM ml_predictions
     WHERE symbol = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [symbol, limit]
  );
  res.json(predictions);
});

apiRouter.post('/start', (req, res) => {
  const engine = getTradingEngine();
  if (engine && !engine.isRunning) {
    engine.start().catch((error: Error) => logger.error('Failed to start engine', { requestId: req.requestId, error: error.message }));
    res.json({ success: true, message: 'Trading engine started' });
  } else {
    res.status(400).json({ success: false, message: 'Engine already running or not initialized' });
  }
});

apiRouter.post('/stop', async (req, res) => {
  const engine = getTradingEngine();
  if (engine && engine.isRunning) {
    await engine.stop();
    res.json({ success: true, message: 'Trading engine stopped' });
  } else {
    res.status(400).json({ success: false, message: 'Engine not running' });
  }
});

apiRouter.post('/timeframe', validateTimeframeBody, async (req, res) => {
  const engine = getTradingEngine();
  const { timeframe } = req.body;
  
  if (!timeframe) {
    return res.status(400).json({ success: false, message: 'Timeframe is required' });
  }

  await runQuery(`
    INSERT OR REPLACE INTO settings (key, value)
    VALUES (?, ?)
  `, ['timeframe', timeframe]);

  if (engine) {
    await engine.setTimeframe(timeframe);
    res.json({ success: true, message: `Timeframe updated to ${timeframe}` });
  } else {
    res.status(500).json({ success: false, message: 'Engine not initialized' });
  }
});

apiRouter.get('/candles', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      const history = req.query.history as string;
      let candles;

      if (history === '1y') {
        const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
        // Calculate limit based on timeframe
        let limit = 35000; // default for 15m
        if (engine.timeframe === '1h') limit = 8760;
        else if (engine.timeframe === '1d') limit = 365;
        else if (engine.timeframe === '5m') limit = 105120;

        if (engine.exchange) {
          candles = await engine.exchange.getHistoricalCandles(engine.symbol, engine.timeframe, oneYearAgo, limit);
        } else {
          candles = [];
        }
      } else {
        if (engine.exchange) {
          candles = await engine.exchange.getCandles(engine.symbol, engine.timeframe, 1000);
        } else {
          candles = [];
        }
      }

      // Check if we have sufficient data - try fallbacks if insufficient
      if (candles.length < 50) {
        logger.info('Insufficient candles from primary source, trying fallbacks', { requestId: req.requestId, count: candles.length, exchange: engine.exchange?.exchangeName });

        // Try CryptoCompare first (most reliable fallback)
        try {
          const ccCandles = await engine.exchange?.fetchCryptoCompareHistorical?.(engine.symbol, engine.timeframe, 500);
          if (ccCandles && ccCandles.length >= 50) {
            candles = ccCandles;
            logger.info('CryptoCompare fallback succeeded', { requestId: req.requestId, count: candles.length });
          }
        } catch (ccError: any) {
          logger.warn('CryptoCompare fallback failed', { requestId: req.requestId, error: ccError.message });
        }

        // If still insufficient, try CoinGecko
        if (candles.length < 50) {
          try {
            const cgCandles = await fetchCoinGeckoHistoricalData(engine.symbol, engine.timeframe, history === '1y' ? 365 : 30);
            if (cgCandles && cgCandles.length >= 50) {
              candles = cgCandles;
              logger.info('CoinGecko fallback succeeded', { requestId: req.requestId, count: candles.length });
            }
          } catch (cgError: any) {
            logger.warn('CoinGecko fallback failed', { requestId: req.requestId, error: cgError.message });
          }
        }

        // If still no data, return error
        if (candles.length < 50) {
          return res.status(503).json({
            error: 'DATA_UNAVAILABLE',
            message: 'Unable to fetch sufficient historical data. Please check your exchange configuration or API keys.',
            providers_tried: ['primary_exchange', 'cryptocompare', 'coingecko']
          });
        }
      }

      // Set cache headers for recent data
      const isRecentData = history === '1y' ? false : true; // Recent data gets cached
      if (isRecentData) {
        res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache for recent data
      }

      if (candles.length >= 50) {
        const df = engine.indicators.calculateAll(candles);
        res.json(df);
      } else {
        res.json(candles);
      }
    } catch (e: any) {
      logger.error('Candles fetch failed', { requestId: req.requestId, error: e.message });
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/market/data', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const data = await engine.marketDataService.getLatestMarketData();
    res.json(data);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/market/news', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const news = await engine.marketDataService.getLatestNews();
    res.json(news);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/market/refresh', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      await engine.marketDataService.fetchMarketData();
      await engine.marketDataService.fetchNews();
      res.json({ success: true });
    } catch (err: any) {
      logger.error('[market/refresh] Failed:', err);
      res.status(500).json({ error: err.message || 'Market refresh failed' });
    }
  } else {
    res.status(503).json({ error: 'Engine not initialized. Start the engine first.' });
  }
});

apiRouter.post('/optimize', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    await engine.optimizationEngine.optimize(engine.currentRegime);
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/performance', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const performance = await engine.shadowTrader.getPerformance();
    res.json(performance);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/trades', async (req, res) => {
  const requestedLimit = parseInt(req.query.limit as string) || 50;
  const limit = Math.max(1, Math.min(requestedLimit, 200));
  
  const trades = await runQuery(`
    SELECT * FROM shadow_trades
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(trades);
});

// Closed shadow trades with PnL for the all-trades history view
apiRouter.get('/shadow-trades/closed', async (req, res) => {
  const requestedLimit = parseInt(req.query.limit as string) || 100;
  const limit = Math.max(1, Math.min(requestedLimit, 500));
  
  const trades = await runQuery(`
    SELECT * FROM shadow_trades
    WHERE status = 'closed'
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(trades);
});

// All shadow trades (open + closed) for chart markers
apiRouter.get('/shadow-trades/all', async (req, res) => {
  const requestedLimit = parseInt(req.query.limit as string) || 200;
  const limit = Math.max(1, Math.min(requestedLimit, 1000));
  
  const trades = await runQuery(`
    SELECT * FROM shadow_trades
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(trades);
});

// Signal history for chart markers
apiRouter.get('/signals', async (req, res) => {
  const requestedLimit = parseInt(req.query.limit as string) || 500;
  const limit = Math.max(1, Math.min(requestedLimit, 2000));
  
  const signals = await runQuery(`
    SELECT * FROM signals
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(signals);
});

// Closed bot trades (non-shadow, real/live trades)
apiRouter.get('/trades/closed', async (req, res) => {
  const requestedLimit = parseInt(req.query.limit as string) || 100;
  const limit = Math.max(1, Math.min(requestedLimit, 500));
  
  const trades = await runQuery(`
    SELECT * FROM trades
    WHERE status = 'closed'
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(trades);
});

apiRouter.get('/history/regime', async (req, res) => {
  const requestedLimit = parseInt(req.query.limit as string) || 20;
  const limit = Math.max(1, Math.min(requestedLimit, 200));
  
  const history = await runQuery(`
    SELECT * FROM regime_history
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(history);
});

apiRouter.post('/settings', validateSettingsBody, async (req, res) => {
  const settings = req.body;
  
  for (const [key, value] of Object.entries(settings)) {
    // Skip API keys and sensitive settings
    if (['apiKey', 'apiSecret', 'apiPassword', 'apiProviders'].includes(key)) {
      continue;
    }
    await runQuery(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES (?, ?)
    `, [key, String(value)]);
  }
  
  const engine = getTradingEngine();
  if (engine) {
    await engine.loadSettings();
  }
  
  res.json({ success: true });
});

apiRouter.get('/settings', async (req, res) => {
  const settings = await runQuery(`SELECT * FROM settings`, [], 'all');
  
  const result: Record<string, string> = {};
  for (const row of settings as any[]) {
    // Skip API keys and sensitive settings in response
    if (['apiKey', 'apiSecret', 'apiPassword', 'apiProviders'].includes(row.key)) {
      continue;
    }
    result[row.key] = row.value;
  }
  
  res.json(result);
});

apiRouter.get('/positions/open', (req, res) => {
  logger.info('Fetching open positions', { requestId: req.requestId });
  const engine = getTradingEngine();
  if (engine) {
    const allOpenTrades = [];
    for (const mode of Object.values(RiskMode)) {
      const portfolio = engine.shadowTrader.portfolios[mode as RiskMode];
      if (portfolio && portfolio.openTrades) {
        allOpenTrades.push(...portfolio.openTrades);
      }
    }
    res.json(allOpenTrades);
  } else {
    logger.warn('Engine not initialized for /positions/open', { requestId: req.requestId });
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/positions/close', validatePositionsCloseBody, async (req, res) => {
  const { tradeId, currentPrice } = req.body;
  const engine = getTradingEngine();
  if (engine) {
    const success = await engine.shadowTrader.closeTrade(
      tradeId, 
      currentPrice, 
      engine.activeMode, 
      engine.balanceManager, 
      engine.exchange
    );
    res.json({ success });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/positions/update', validatePositionsUpdateBody, async (req, res) => {
  const { tradeId, stopLoss, takeProfit } = req.body;
  const engine = getTradingEngine();
  if (engine) {
    const success = await engine.shadowTrader.updateTradeParams(tradeId, stopLoss, takeProfit);
    res.json({ success });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/risk-configs', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const configs = engine.shadowTrader.riskManager.RISK_CONFIGS;
    // Merge with defaults to ensure all fields exist
    const enrichedConfigs: Record<string, any> = {};
    for (const [mode, defaultConfig] of Object.entries(DEFAULT_RISK_CONFIGS)) {
      enrichedConfigs[mode] = { ...defaultConfig, ...(configs[mode] || {}) };
    }
    res.json(enrichedConfigs);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/risk-configs', validateRiskConfigsBody, (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    engine.shadowTrader.riskManager.saveConfigs(req.body);
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/risk-configs/reset', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    engine.shadowTrader.riskManager.saveConfigs(DEFAULT_RISK_CONFIGS);
    res.json({ success: true, configs: DEFAULT_RISK_CONFIGS });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

import OpenAI from 'openai';

let aiRecommendationsEnabled = true;

apiRouter.post('/risk-configs/ai-recommend', async (req, res) => {
  const engine = getTradingEngine();
  if (!engine) {
    return res.status(500).json({ error: 'Engine not initialized' });
  }
  
  const currentRegime = engine.currentRegime;
  const currentConfigs = JSON.parse(JSON.stringify(engine.shadowTrader.riskManager.RISK_CONFIGS));
  
  if (!aiRecommendationsEnabled) {
    // Fallback immediately
    for (const mode of Object.values(RiskMode)) {
      if (currentRegime === 'strongbull' || currentRegime === 'bear') {
        currentConfigs[mode].tpMultiplier = Math.max(1.5, currentConfigs[mode].tpMultiplier * 1.2);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 0.8);
      } else if (currentRegime === 'sideways') {
        currentConfigs[mode].tpMultiplier = Math.max(1.0, currentConfigs[mode].tpMultiplier * 0.8);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 1.2);
      }
    }
    return res.json({ success: true, configs: currentConfigs });
  }

  try {
    const openai = new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      apiKey: 'ollama'
    });
    
    const prompt = `You are an expert quantitative trader. The current market regime is "${currentRegime}". 
    The current risk configurations for different modes are:
    ${JSON.stringify(currentConfigs, null, 2)}
    
    Please analyze the market regime and recommend adjustments to the risk configurations (maxRiskPerTrade, maxDrawdown, confidenceThreshold, tpMultiplier, slMultiplier, leverage) for each mode to optimize performance in this regime.
    Return the updated configurations in JSON format matching the keys of the input.`;

    const response = await openai.chat.completions.create({
      model: process.env.OLLAMA_MODEL || "llama3",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }]
    });

    const text = response.choices[0].message.content;
    if (text) {
      const recommendedConfigs = JSON.parse(text);
      
      // Merge recommended configs with existing descriptions and maxConcurrentPositions
      for (const mode of Object.keys(currentConfigs)) {
        if (recommendedConfigs[mode]) {
          currentConfigs[mode] = { ...currentConfigs[mode], ...recommendedConfigs[mode] };
        }
      }
      
      res.json({ success: true, configs: currentConfigs });
    } else {
      throw new Error("No response from AI");
    }
  } catch (error: any) {
    console.error("AI Risk Recommendation failed:", error.message);
    if (error.message && error.message.includes("fetch failed")) {
       aiRecommendationsEnabled = false;
    }
    // Fallback to simple logic — always produce non-zero values
    for (const mode of Object.values(RiskMode)) {
      if (currentRegime === 'strongbull' || currentRegime === 'bear') {
        currentConfigs[mode].takeProfit = Math.max(1.5, (currentConfigs[mode].takeProfit || 1.8) * 1.2);
        currentConfigs[mode].stopLoss = Math.min(5.0, (currentConfigs[mode].stopLoss || 2.5) * 0.8);
        currentConfigs[mode].positionSize = Math.min(0.15, (currentConfigs[mode].positionSize || 0.05) * 1.2);
      } else if (currentRegime === 'sideways') {
        currentConfigs[mode].takeProfit = Math.max(1.0, (currentConfigs[mode].takeProfit || 1.8) * 0.8);
        currentConfigs[mode].stopLoss = Math.min(5.0, (currentConfigs[mode].stopLoss || 2.5) * 1.2);
        currentConfigs[mode].positionSize = Math.min(0.1, (currentConfigs[mode].positionSize || 0.05) * 0.8);
      } else {
        // weak_bull or uncertain — moderate adjustments
        currentConfigs[mode].takeProfit = currentConfigs[mode].takeProfit || 1.8;
        currentConfigs[mode].stopLoss = currentConfigs[mode].stopLoss || 2.5;
        currentConfigs[mode].positionSize = currentConfigs[mode].positionSize || 0.05;
      }
    }
    res.json({ success: true, configs: currentConfigs });
  }
});

apiRouter.post('/backtest', validateBacktestBody, async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { mode, config, startTime, endTime } = req.body;
    const result = await engine.runBacktest(mode, config, startTime, endTime);
    res.json(result);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/balances', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const baseBalances = await engine.balanceManager.getBalances();

    // Aggregate shadow portfolio positions into active trade balance
    let totalActiveTrade = 0;
    let unrealizedPnl = 0;
    for (const mode of Object.values(RiskMode)) {
      const portfolio = engine.shadowTrader.portfolios[mode as RiskMode];
      if (portfolio && portfolio.openTrades) {
        for (const trade of portfolio.openTrades) {
          const currentValue = (trade.amount || 0) * ((trade.currentPrice || trade.price) || 0);
          totalActiveTrade += currentValue;
          const entryValue = (trade.amount || 0) * (trade.price || 0);
          unrealizedPnl += trade.side === 'buy' ? currentValue - entryValue : entryValue - currentValue;
        }
      }
    }

    // Historical PnL from DB (accumulated from closed trades)
    const dbBalances = await engine.balanceManager.getBalances();
    const historicalPnl = dbBalances.totalPnl || 0;
    const totalPnl = historicalPnl + unrealizedPnl;

    res.json({
      ...baseBalances,
      activeTradeBalance: totalActiveTrade,
      totalPnl: totalPnl,
      totalPnlPct: baseBalances.botBalance > 0
        ? (totalPnl / baseBalances.botBalance) * 100
        : (baseBalances.mainBalance > 0 ? (totalPnl / baseBalances.mainBalance) * 100 : 0)
    });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/allocate', validateAmountBody, async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { amount } = req.body;
    try {
      await engine.balanceManager.allocateToBot(amount);
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/withdraw', validateAmountBody, async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { amount } = req.body;
    try {
      await engine.balanceManager.withdrawFromBot(amount);
      // Distribute withdrawal across ALL shadow portfolios equally
      const modes = Object.keys(engine.shadowTrader.portfolios || {});
      const perMode = modes.length > 0 ? amount / modes.length : amount;
      for (const mode of modes) {
        const portfolio = engine.shadowTrader.portfolios[mode];
        if (portfolio) {
          portfolio.initialBalance = Math.max(0, (portfolio.initialBalance || 0) - perMode);
          portfolio.balance = Math.max(0, (portfolio.balance || 0) - perMode);
        }
      }
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/half', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      const current = await engine.balanceManager.getBalances();
      const amount = current.botBalance / 2;
      await engine.balanceManager.halfBotBalance();
      const portfolio = engine.shadowTrader.portfolios[engine.activeMode as any];
      if (portfolio) {
        portfolio.initialBalance -= amount;
        portfolio.balance -= amount;
      }
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/double', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      const current = await engine.balanceManager.getBalances();
      const amount = current.botBalance;
      await engine.balanceManager.doubleBotBalance();
      const portfolio = engine.shadowTrader.portfolios[engine.activeMode as any];
      if (portfolio) {
        portfolio.initialBalance += amount;
        portfolio.balance += amount;
      }
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/kill', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      await engine.killBot();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/active-mode', validateActiveModeBody, async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { mode } = req.body;
    engine.activeMode = mode;
    await runQuery(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['activeMode', mode]);
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/regime/manual', validateManualRegimeBody, (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { regime } = req.body;
    engine.manualRegime = normalizeRegime(regime) as any;
    res.json({ success: true, regime: normalizeRegime(regime) });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/import-csv', upload.single('file'), async (req, res) => {
  const file = (req as any).file;
  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const results: any[] = [];
  fs.createReadStream(file.path)
    .pipe(parse({ columns: true, skip_empty_lines: true }))
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      try {
        // Save to database
        for (const row of results) {
          await runQuery(`
            INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            row.symbol,
            row.timeframe,
            row.time,
            row.open,
            row.high,
            row.low,
            row.close,
            row.volume
          ]);
        }
        res.json({ success: true, message: `Imported ${results.length} rows` });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      } finally {
        fs.unlinkSync(file.path);
      }
    })
    .on('error', (err) => {
      res.status(500).json({ error: err.message });
      fs.unlinkSync(file.path);
    });
});

apiRouter.post('/manual-trade', validateManualTradeBody, async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    if (!engine.isRunning) {
      await engine.start().catch(console.error);
    }
    const { side, symbol, price, stopLoss, takeProfit } = req.body;
    
    // Create a manual signal
    const signal = {
      symbol,
      side,
      confidence: 100,
      entryPrice: price,
      stopLoss,
      takeProfit,
      reasoning: 'Manual entry',
      indicators: ['Manual']
    };

    try {
      // Execute trade
      await engine.shadowTrader.processSignal(
        signal,
        price,
        engine.activeMode,
        engine.balanceManager,
        engine.exchange,
        engine.currentRegime
      );
      res.json({ success: true, message: 'Manual trade opened' });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(400).json({ error: 'Engine not running' });
  }
});

// Slippage Modeling Endpoints
const validateCostEstimateBody = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  size: z.number().positive(),
  type: z.enum(['market', 'limit']).optional().default('market'),
  limitPrice: z.number().positive().optional(),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK']).optional().default('GTC')
});

const validateCostEstimate = (req: any, res: any, next: any) => {
  try {
    req.body = validateCostEstimateBody.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors
      });
    }
    next(error);
  }
};

apiRouter.post('/slippage/estimate', validateCostEstimate, async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const engine = getTradingEngine();
    if (!engine || !engine.slippageEngine) {
      return res.status(503).json({ error: 'Slippage engine not available' });
    }

    const { symbol, side, size, type, limitPrice, timeInForce } = req.body;
    const orderRequest = {
      symbol,
      side,
      size,
      type,
      limitPrice,
      timeInForce
    };

    const costEstimate = await engine.slippageEngine.costEstimator.estimateTotalCost(orderRequest);

    recordApiRequest('/slippage/estimate', 'POST', 200, Date.now() - startTime);

    res.json({
      requestId,
      estimate: {
        totalCost: costEstimate.total.toString(),
        confidence: costEstimate.confidence,
        breakdown: {
          slippage: {
            total: costEstimate.breakdown.slippage.totalSlippage.toString(),
            confidence: costEstimate.breakdown.slippage.confidence,
            components: {
              permanentImpact: costEstimate.breakdown.slippage.breakdown.permanentImpact.toString(),
              temporaryImpact: costEstimate.breakdown.slippage.breakdown.temporaryImpact.toString(),
              spreadCost: costEstimate.breakdown.slippage.breakdown.spreadCost.toString()
            }
          },
          fees: {
            makerFee: costEstimate.breakdown.fees.makerFee.toString(),
            takerFee: costEstimate.breakdown.fees.takerFee.toString(),
            total: costEstimate.breakdown.fees.total.toString(),
            confidence: costEstimate.breakdown.fees.confidence
          },
          networkCosts: {
            total: costEstimate.breakdown.networkCosts.total.toString(),
            confidence: costEstimate.breakdown.networkCosts.confidence
          }
        }
      }
    });
  } catch (error: any) {
    recordApiRequest('/slippage/estimate', 'POST', 500, Date.now() - startTime);
    logger.error('Cost estimation failed', { requestId, error: error.message });
    res.status(500).json({ error: 'Cost estimation failed', requestId });
  }
});

apiRouter.post('/slippage/backtest', validateBacktestBody, async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const engine = getTradingEngine();
    if (!engine || !engine.slippageEngine) {
      return res.status(503).json({ error: 'Slippage engine not available' });
    }

    const { symbol, startDate, endDate, orderSize, scenarios = ['expected'] } = req.body;

    // Simplified backtest - in production this would run comprehensive analysis
    const mockResults = {
      symbol,
      period: { start: startDate, end: endDate },
      orderSize,
      scenarios: scenarios.map(scenario => ({
        scenario,
        expectedSlippage: 0.005, // 0.5%
        worstCaseSlippage: 0.015, // 1.5%
        rmse: 0.003,
        directionalAccuracy: 0.85
      }))
    };

    recordApiRequest('/slippage/backtest', 'POST', 200, Date.now() - startTime);

    res.json({
      requestId,
      backtest: mockResults
    });
  } catch (error: any) {
    recordApiRequest('/slippage/backtest', 'POST', 500, Date.now() - startTime);
    logger.error('Backtest failed', { requestId, error: error.message });
    res.status(500).json({ error: 'Backtest failed', requestId });
  }
});

apiRouter.get('/slippage/history', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const { symbol, limit = 100 } = req.query;

    const whereClause = symbol ? 'WHERE symbol = ?' : '';
    const params = symbol ? [symbol] : [];

    const history = await runQuery(
      `SELECT * FROM slippage_history ${whereClause} ORDER BY timestamp DESC LIMIT ?`,
      [...params, limit],
      'all'
    );

    recordApiRequest('/slippage/history', 'GET', 200, Date.now() - startTime);

    res.json({
      requestId,
      history: history.map((record: any) => ({
        id: record.id,
        symbol: record.symbol,
        timestamp: record.timestamp,
        side: record.side,
        orderSize: record.order_size,
        orderType: record.order_type,
        predictedSlippage: record.predicted_slippage,
        realizedSlippage: record.realized_slippage,
        confidence: record.confidence,
        regime: record.regime,
        volatility: record.volatility,
        marketImpact: record.market_impact,
        spreadCost: record.spread_cost,
        temporaryImpact: record.temporary_impact,
        exchange: record.exchange
      }))
    });
  } catch (error: any) {
    recordApiRequest('/slippage/history', 'GET', 500, Date.now() - startTime);
    logger.error('Failed to fetch slippage history', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to fetch slippage history', requestId });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Freqtrade API Routes (Phase 4)
// ──────────────────────────────────────────────────────────────────────

apiRouter.post('/freqtrade/download-data', validateFreqtradeDownloadBody, async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const queue = getFreqtradeDataQueue();
    if (!queue) {
      return res.status(503).json({ error: 'Freqtrade data queue not available. Ensure Redis is running and FREQTRADE_ENABLED=true.' });
    }

    const jobId = crypto.randomUUID();
    const payload = { ...req.body, jobId };

    await runQuery(
      `INSERT INTO freqtrade_jobs (id, type, status, exchange, timerange_start, timerange_end, params_json, created_at, updated_at)
       VALUES (?, 'download', 'queued', ?, ?, ?, ?, ?, ?)`,
      [jobId, payload.exchange, payload.timerange?.start || null, payload.timerange?.end || null, JSON.stringify(payload), Date.now(), Date.now()],
      'run'
    );

    await queue.add('download-data', payload, { jobId });

    recordApiRequest('/freqtrade/download-data', 'POST', 202, Date.now() - startTime);
    res.status(202).json({ requestId, jobId, message: 'Download job queued' });
  } catch (error: any) {
    recordApiRequest('/freqtrade/download-data', 'POST', 500, Date.now() - startTime);
    logger.error('Failed to queue Freqtrade download', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to queue download job', requestId });
  }
});

apiRouter.post('/freqtrade/backtest', validateFreqtradeBacktestBody, async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const queue = getFreqtradeBacktestQueue();
    if (!queue) {
      return res.status(503).json({ error: 'Freqtrade backtest queue not available. Ensure Redis is running and FREQTRADE_ENABLED=true.' });
    }

    const jobId = crypto.randomUUID();
    const payload = { ...req.body, jobId };

    await runQuery(
      `INSERT INTO freqtrade_jobs (id, type, status, strategy, timerange_start, timerange_end, params_json, created_at, updated_at)
       VALUES (?, 'backtest', 'queued', ?, ?, ?, ?, ?, ?)`,
      [jobId, payload.strategy, payload.timerange?.start || null, payload.timerange?.end || null, JSON.stringify(payload), Date.now(), Date.now()],
      'run'
    );

    await queue.add('backtest', payload, { jobId });

    recordApiRequest('/freqtrade/backtest', 'POST', 202, Date.now() - startTime);
    res.status(202).json({ requestId, jobId, message: 'Backtest job queued' });
  } catch (error: any) {
    recordApiRequest('/freqtrade/backtest', 'POST', 500, Date.now() - startTime);
    logger.error('Failed to queue Freqtrade backtest', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to queue backtest job', requestId });
  }
});

apiRouter.post('/freqtrade/validate', validateFreqtradeValidateBody, async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const queue = getFreqtradeValidateQueue();
    if (!queue) {
      return res.status(503).json({ error: 'Freqtrade validate queue not available. Ensure Redis is running and FREQTRADE_ENABLED=true.' });
    }

    const jobId = crypto.randomUUID();
    const payload = { ...req.body, jobId };

    await runQuery(
      `INSERT INTO freqtrade_jobs (id, type, status, strategy, timerange_start, timerange_end, params_json, created_at, updated_at)
       VALUES (?, 'validate', 'queued', ?, ?, ?, ?, ?, ?)`,
      [jobId, payload.strategy, payload.timerange.start, payload.timerange.end, JSON.stringify(payload), Date.now(), Date.now()],
      'run'
    );

    await queue.add('validate', payload, { jobId });

    recordApiRequest('/freqtrade/validate', 'POST', 202, Date.now() - startTime);
    res.status(202).json({ requestId, jobId, message: 'Validation job queued' });
  } catch (error: any) {
    recordApiRequest('/freqtrade/validate', 'POST', 500, Date.now() - startTime);
    logger.error('Failed to queue Freqtrade validate', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to queue validation job', requestId });
  }
});

apiRouter.get('/freqtrade/info', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const bridge = new FreqtradeBridge();
    const [pingOk, strategies] = await Promise.all([
      bridge.ping(),
      bridge.listStrategies().catch(() => [])
    ]);

    recordApiRequest('/freqtrade/info', 'GET', 200, Date.now() - startTime);
    res.json({
      requestId,
      installed: pingOk,
      strategies
    });
  } catch (error: any) {
    recordApiRequest('/freqtrade/info', 'GET', 500, Date.now() - startTime);
    logger.error('Failed to get Freqtrade info', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to get Freqtrade info', requestId });
  }
});

apiRouter.get('/freqtrade/pairs', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    // For now, return a static list or read from config. 
    // In a full implementation, this would call `freqtrade list-data` or query the DB.
    // We'll query the candles table for available pairs/timeframes as a proxy.
    const pairs = await runQuery(
      `SELECT DISTINCT symbol, timeframe FROM candles ORDER BY symbol, timeframe`,
      [],
      'all'
    );

    recordApiRequest('/freqtrade/pairs', 'GET', 200, Date.now() - startTime);
    res.json({ requestId, pairs });
  } catch (error: any) {
    recordApiRequest('/freqtrade/pairs', 'GET', 500, Date.now() - startTime);
    logger.error('Failed to get Freqtrade pairs', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to get Freqtrade pairs', requestId });
  }
});

apiRouter.get('/freqtrade/jobs', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const jobs = await runQuery(
      `SELECT id, type, status, exchange, strategy, timerange_start, timerange_end, created_at, completed_at, error 
       FROM freqtrade_jobs 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [limit],
      'all'
    );

    recordApiRequest('/freqtrade/jobs', 'GET', 200, Date.now() - startTime);
    res.json({ requestId, jobs });
  } catch (error: any) {
    recordApiRequest('/freqtrade/jobs', 'GET', 500, Date.now() - startTime);
    logger.error('Failed to get Freqtrade jobs', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to get Freqtrade jobs', requestId });
  }
});

apiRouter.get('/freqtrade/jobs/:id', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();
  const { id } = req.params;

  try {
    const job = await runQuery(
      `SELECT * FROM freqtrade_jobs WHERE id = ?`,
      [id],
      'all'
    );

    if (job.length === 0) {
      return res.status(404).json({ error: 'Job not found', requestId });
    }

    recordApiRequest('/freqtrade/jobs/:id', 'GET', 200, Date.now() - startTime);
    res.json({ requestId, job: job[0] });
  } catch (error: any) {
    recordApiRequest('/freqtrade/jobs/:id', 'GET', 500, Date.now() - startTime);
    logger.error('Failed to get Freqtrade job', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to get Freqtrade job', requestId });
  }
});

// ── Cancel job ─────────────────────────────────────────────────────
apiRouter.post('/freqtrade/jobs/:id/cancel', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();
  const { id } = req.params;

  try {
    // Look up the job in the DB
    const jobs = await runQuery(
      `SELECT id, type, status, params_json FROM freqtrade_jobs WHERE id = ?`,
      [id],
      'all',
    ) as any[];

    if (!jobs || jobs.length === 0) {
      recordApiRequest('/freqtrade/jobs/:id/cancel', 'POST', 404, Date.now() - startTime);
      return res.status(404).json({ error: 'Job not found', requestId });
    }

    const job = jobs[0];

    // Only cancelleable if still queued or running
    if (!['queued', 'running'].includes(job.status)) {
      recordApiRequest('/freqtrade/jobs/:id/cancel', 'POST', 400, Date.now() - startTime);
      return res.status(400).json({
        error: `Job is ${job.status} and cannot be cancelled`,
        requestId,
        status: job.status,
      });
    }

    // Determine which queue holds this job
    const queueMap: Record<string, () => import('bullmq').Queue | null> = {
      download: () => getFreqtradeDataQueue(),
      backtest: () => getFreqtradeBacktestQueue(),
      validate: () => getFreqtradeValidateQueue(),
    };
    const queueFn = queueMap[job.type];
    let queueRemoved = false;

    if (queueFn) {
      const queue = queueFn();
      if (queue) {
        try {
          const bullJob = await queue.getJob(id);
          if (bullJob) {
            await bullJob.remove();
            queueRemoved = true;
          }
        } catch (qe: any) {
          logger.warn('BullMQ job remove failed (non-fatal)', {
            jobId: id,
            error: qe?.message ?? String(qe),
          });
        }
      }
    }

    // For running jobs, also try to kill the bridge child process
    if (job.status === 'running') {
      try {
        const { FreqtradeBridge } = await import('../freqtrade/bridge.js');
        const bridge = new FreqtradeBridge();
        await bridge.cancel(id);
      } catch (be: any) {
        logger.warn('Bridge cancel failed (non-fatal)', {
          jobId: id,
          error: be?.message ?? String(be),
        });
      }
    }

    // Update DB
    await runQuery(
      `UPDATE freqtrade_jobs SET status='cancelled', completed_at=?, updated_at=? WHERE id=?`,
      [Date.now(), Date.now(), id],
      'run',
    );

    recordApiRequest('/freqtrade/jobs/:id/cancel', 'POST', 200, Date.now() - startTime);
    res.json({
      requestId,
      jobId: id,
      message: `Job cancelled (queue removed: ${queueRemoved})`,
    });
  } catch (error: any) {
    recordApiRequest('/freqtrade/jobs/:id/cancel', 'POST', 500, Date.now() - startTime);
    logger.error('Failed to cancel Freqtrade job', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to cancel job', requestId });
  }
});

apiRouter.post('/freqtrade/ingest', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();

  try {
    const bridge = new FreqtradeBridge();
    const userDataDir = bridge.getUserDataDir();
    const dataDir = path.join(userDataDir, 'data');
    
    // We'll spawn the python script directly for now. 
    // In a more robust setup, this would be a BullMQ job.
    const scriptPath = path.join(process.cwd(), 'backend/freqtrade/scripts/bulk_ingest_candles.py');
    const dbPath = path.join(process.cwd(), 'trading.db');
    
    const child = spawn('python3', [scriptPath, '--db', dbPath, '--data-dir', dataDir], {
      stdio: 'pipe',
      cwd: process.cwd()
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        recordApiRequest('/freqtrade/ingest', 'POST', 200, Date.now() - startTime);
        res.json({ requestId, message: 'Ingest completed successfully', output: stdout.trim() });
      } else {
        recordApiRequest('/freqtrade/ingest', 'POST', 500, Date.now() - startTime);
        logger.error('Freqtrade ingest failed', { requestId, code, stderr });
        res.status(500).json({ error: 'Ingest failed', requestId, stderr: stderr.trim() });
      }
    });

    child.on('error', (err) => {
      recordApiRequest('/freqtrade/ingest', 'POST', 500, Date.now() - startTime);
      logger.error('Freqtrade ingest spawn error', { requestId, error: err.message });
      res.status(500).json({ error: 'Failed to spawn ingest script', requestId });
    });
  } catch (error: any) {
    recordApiRequest('/freqtrade/ingest', 'POST', 500, Date.now() - startTime);
    logger.error('Failed to start Freqtrade ingest', { requestId, error: error.message });
    res.status(500).json({ error: 'Failed to start ingest', requestId });
  }
});

// Paper Trading Routes
apiRouter.use('/paper', paperTradingRouter);

// JSON 404 catch-all for unmatched /api/* routes.
// Without this, requests to unknown paths (or GET requests to POST-only routes
// like /active-mode, /regime/manual, /market/refresh) fall through to the
// Vite/static catch-all and return the HTML index page (1719 bytes) instead
// of a meaningful JSON error. This is critical for the CLI and any client
// that expects JSON.
apiRouter.use((req: any, res: any, next: any) => {
if (res.headersSent) return next();
// If no route matched above, return a clean JSON 404 instead of letting
// the request reach the static-file middleware.
return res.status(404).json({
  error: 'Not Found',
  route: req.originalUrl || req.url,
  method: req.method,
  requestId: req.requestId,
  hint: 'Check the API path and HTTP method. See backend/api/routes.ts for the full list of registered routes.'
});
});
