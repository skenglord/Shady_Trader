import { Router } from 'express';
import { runQuery } from '../database.js';
import { getTradingEngine, getStartupDiagnostics } from '../main.js';
import { RiskMode, DEFAULT_RISK_CONFIGS } from '../risk/manager.js';
import { RegimeType } from '../regime/detector.js';
import multer from 'multer';
import { parse } from 'csv-parse';
import fs from 'fs';
import { z } from 'zod';
import { getRequestId, logger } from '../logging/logger.js';
import { getApiMetricsSnapshot, recordApiRequest, toPrometheusMetrics } from '../observability/requestMetrics.js';
import paperTradingRouter from '../paper-trading/paper-trading.controller.js';
import Redis from 'ioredis';
import crypto from 'crypto';

const upload = multer({ dest: 'uploads/' });
export const apiRouter = Router();

// Redis instance for idempotency
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || '',
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
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
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: 'API authentication is not configured' });
      }
      return next();
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

apiRouter.get('/health/ready', async (req, res) => {
  try {
    // Check database connectivity
    await runQuery('SELECT 1', [], 'run');

    // Check Redis connectivity
    const redis = getRedis();
    await redis.ping();

    // Check trading engine status
    const engine = getTradingEngine();
    if (!engine) {
      return res.status(503).json({ status: 'not ready', reason: 'Trading engine not initialized' });
    }

    res.status(200).json({
      status: 'ready',
      timestamp: Date.now(),
      components: {
        database: 'ok',
        redis: 'ok',
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
  '/diagnostics'
];

const traderRoutes = [
  '/timeframe',
  '/market/refresh',
  '/positions/close',
  '/positions/update',
  '/balances/allocate',
  '/balances/withdraw',
  '/balances/half',
  '/balances/double',
  '/active-mode',
  '/regime/manual',
  '/manual-trade'
];

for (const route of adminRoutes) {
  apiRouter.use(route, requireRole('admin'));
}
for (const route of traderRoutes) {
  apiRouter.use(route, requireRole('trader'));
}

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
  regime: z.string().refine((v) => regimeModes.has(v as RegimeType), 'Invalid regime')
}));

const validateManualTradeBody = validateBody(z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string().trim().min(1, 'symbol is required'),
  price: z.number().positive('price must be a positive number'),
  stopLoss: z.number().positive('stopLoss must be a positive number'),
  takeProfit: z.number().positive('takeProfit must be a positive number')
}));

apiRouter.get('/status', (req, res) => {
  const engine = getTradingEngine();
  res.json({
    isRunning: engine?.isRunning || false,
    currentRegime: engine?.currentRegime || 'uncertain',
    symbol: engine?.symbol || 'BTC/USDT',
    timeframe: engine?.timeframe || '15m'
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
  return res.json({
    uptimeSec: Math.floor(process.uptime()),
    requestId: req.requestId,
    isRunning: engine.isRunning,
    startup: engine.getStartupDiagnostics(),
    api: apiMetrics,
    marketData: {
      hasCachedData: Boolean(latestMarketData),
      lastUpdated: latestMarketData?.last_updated || null,
      metrics: marketMetrics
    }
  });
});

apiRouter.get('/diagnostics/metrics', async (req, res) => {
  const engine = getTradingEngine();
  if (!engine) {
    return res.status(500).json({ error: 'Engine not initialized' });
  }

  const marketMetrics = engine.marketDataService.getMetrics();
  const payload = toPrometheusMetrics(marketMetrics);
  res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  return res.send(payload);
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

apiRouter.post('/stop', (req, res) => {
  const engine = getTradingEngine();
  if (engine && engine.isRunning) {
    engine.stop();
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
    engine.setTimeframe(timeframe);
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

      // Check if we have sufficient data
      if (candles.length < 50) {
        // For CoinMarketCap, historical data requires paid API key
        if (engine.exchange?.exchangeName === 'coinmarketcap') {
          const hasApiKey = Boolean(engine.exchange.apiKey && engine.exchange.apiKey.trim());
          if (!hasApiKey) {
            return res.status(402).json({
              error: 'API_KEY_REQUIRED',
              message: 'CoinMarketCap historical data requires a paid API key. Please configure your API key in settings.',
              provider: 'coinmarketcap',
              action: 'configure_api_key'
            });
          } else {
            // API key provided but still no data - likely rate limited or invalid key
            return res.status(503).json({
              error: 'DATA_UNAVAILABLE',
              message: 'Unable to fetch historical data. Please check your API key or try again later.',
              provider: 'coinmarketcap'
            });
          }
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
    await engine.marketDataService.fetchMarketData();
    await engine.marketDataService.fetchNews();
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
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

apiRouter.get('/performance', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const performance = engine.shadowTrader.getPerformance();
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
    // Skip API keys and exchange settings
    if (['apiKey', 'apiSecret', 'apiPassword', 'exchange', 'apiProviders'].includes(key)) {
      continue;
    }
    await runQuery(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES (?, ?)
    `, [key, String(value)]);
  }
  
  const engine = getTradingEngine();
  if (engine) {
    engine.loadSettings();
  }
  
  res.json({ success: true });
});

apiRouter.get('/settings', async (req, res) => {
  const settings = await runQuery(`SELECT * FROM settings`, [], 'all');
  
  const result: Record<string, string> = {};
  for (const row of settings as any[]) {
    // Skip API keys and exchange settings in response
    if (['apiKey', 'apiSecret', 'apiPassword', 'exchange', 'apiProviders'].includes(row.key)) {
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
    res.json(engine.shadowTrader.riskManager.RISK_CONFIGS);
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

import { GoogleGenAI, Type } from '@google/genai';

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
      if (currentRegime === 'strong_bull' || currentRegime === 'bear') {
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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set.");
    }
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `You are an expert quantitative trader. The current market regime is "${currentRegime}". 
    The current risk configurations for different modes are:
    ${JSON.stringify(currentConfigs, null, 2)}
    
    Please analyze the market regime and recommend adjustments to the risk configurations (maxRiskPerTrade, maxDrawdown, confidenceThreshold, tpMultiplier, slMultiplier, leverage) for each mode to optimize performance in this regime.
    Return the updated configurations in JSON format.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            ultra_conservative: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            conservative: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            moderate: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            aggressive: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            degen: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } }
          }
        }
      }
    });

    if (response.text) {
      const recommendedConfigs = JSON.parse(response.text);
      
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
    if (error.message && error.message.includes("API_KEY_INVALID")) {
      console.error("AI Recommendation failed: Invalid API Key. Disabling AI features.");
      aiRecommendationsEnabled = false;
    } else {
      console.error("AI Recommendation failed:", error);
    }
    // Fallback to simple logic
    for (const mode of Object.values(RiskMode)) {
      if (currentRegime === 'strong_bull' || currentRegime === 'bear') {
        currentConfigs[mode].tpMultiplier = Math.max(1.5, currentConfigs[mode].tpMultiplier * 1.2);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 0.8);
      } else if (currentRegime === 'sideways') {
        currentConfigs[mode].tpMultiplier = Math.max(1.0, currentConfigs[mode].tpMultiplier * 0.8);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 1.2);
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
    res.json(await engine.balanceManager.getBalances());
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
      // Update the active portfolio initial balance to reflect the new allocation
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

apiRouter.post('/balances/withdraw', validateAmountBody, async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { amount } = req.body;
    try {
      await engine.balanceManager.withdrawFromBot(amount);
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
    engine.manualRegime = regime;
    res.json({ success: true, regime });
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

// Paper Trading Routes
apiRouter.use('/paper', paperTradingRouter);
