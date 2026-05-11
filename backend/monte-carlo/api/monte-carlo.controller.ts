// Monte Carlo API Controller
import { Router } from 'express';
import { z } from 'zod';
import { MonteCarloEngine } from '../engine/monte-carlo-engine.js';
import { MonteCarloRequest, MonteCarloResult } from '../types/index.js';
import { getRequestId, logger } from '../../logging/logger.js';
import { recordApiRequest } from '../../observability/requestMetrics.js';
import rateLimit from 'express-rate-limit';

const router = Router();

// Rate limiter for Monte Carlo simulations
const mcRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many Monte Carlo simulation requests, please try again later.'
  },
  skipSuccessfulRequests: false
});

// Validation schemas
const MonteCarloRequestSchema = z.object({
  portfolio: z.object({
    positions: z.array(z.object({
      symbol: z.string(),
      quantity: z.number().positive(),
      currentPrice: z.number().positive()
    })).min(1)
  }),
  parameters: z.object({
    timeHorizon: z.number().int().min(1).max(365),
    confidenceLevels: z.array(z.number().min(0.5).max(0.999)).min(1),
    numPaths: z.number().int().min(1000).max(1000000),
    model: z.enum(['gbm', 'jump-diffusion', 'heston'])
  }),
  correlationMatrix: z.array(z.array(z.number())).optional()
});

const StressTestSchema = z.object({
  portfolio: z.object({
    positions: z.array(z.object({
      symbol: z.string(),
      quantity: z.number().positive(),
      currentPrice: z.number().positive()
    })).min(1)
  }),
  scenarios: z.array(z.object({
    type: z.enum(['black-swan', 'flash-crash', 'liquidity-crisis', 'regime-shift']),
    intensity: z.number().min(0.1).max(2.0).optional()
  })).min(1),
  numPaths: z.number().int().min(10000).max(500000).optional()
});

// Initialize Monte Carlo engine
const mcEngine = new MonteCarloEngine();

/**
 * POST /api/mc/simulate
 * Start a Monte Carlo simulation
 */
router.post('/simulate', mcRateLimiter, async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  
const startTime = Date.now();
    const routeKey = '/api/mc/simulate';

    try {
      // Validate request
      const validationResult = MonteCarloRequestSchema.safeParse(req.body);

      if (!validationResult.success) {
        recordApiRequest(routeKey, 'POST', 400, Date.now() - startTime);
      return res.status(400).json({
        error: 'Invalid request parameters',
        details: validationResult.error.errors
      });
    }
    
    const request = validationResult.data as MonteCarloRequest;
    
    logger.info('Starting Monte Carlo simulation', {
      requestId,
      numPaths: request.parameters.numPaths,
      model: request.parameters.model,
      positions: request.portfolio.positions.length
    });
    
    // Start simulation
    const result = await mcEngine.simulate(request);

    recordApiRequest('/api/mc/simulate', 'POST', 200, Date.now() - startTime);
    
    res.status(202).json(result);
  } catch (error) {
    logger.error('Monte Carlo simulation error', {
      requestId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    recordApiRequest(routeKey, 'POST', 500, Date.now() - startTime);

    res.status(500).json({
      error: 'Simulation failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/mc/status/:jobId
 * Get simulation status
 */
router.get('/status/:jobId', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();
  const routeKey = '/api/mc/status';
  const { jobId } = req.params;

  try {
    const result = await mcEngine.getStatus(jobId);

    if (!result) {
      recordApiRequest(routeKey, 'GET', 404, Date.now() - startTime);
      return res.status(404).json({
        error: 'Job not found'
      });
    }

    recordApiRequest(routeKey, 'GET', 200, Date.now() - startTime);
    res.json(result);
  } catch (error) {
    logger.error('Failed to get Monte Carlo status', {
      requestId,
      jobId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    recordApiRequest(routeKey, 'GET', 500, Date.now() - startTime);
    res.status(500).json({
      error: 'Failed to retrieve status'
    });
  }
});

/**
 * POST /api/mc/stress
 * Run portfolio stress tests
 */
router.post('/stress', mcRateLimiter, async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();
  const routeKey = '/api/mc/stress';

  try {
    // Validate request
    const validationResult = StressTestSchema.safeParse(req.body);

    if (!validationResult.success) {
      recordApiRequest(routeKey, 'POST', 400, Date.now() - startTime);
      return res.status(400).json({
        error: 'Invalid request parameters',
        details: validationResult.error.errors
      });
    }

    // Zod parsing successful - data is valid, cast to make TypeScript happy
    const portfolio = validationResult.data.portfolio as { positions: Array<{ symbol: string; quantity: number; currentPrice: number }> };
    const scenarios = validationResult.data.scenarios as Array<{ type: 'black-swan' | 'flash-crash' | 'liquidity-crisis' | 'regime-shift'; intensity?: number }>;
    const numPaths = validationResult.data.numPaths ?? 100000;

    logger.info('Starting stress tests', {
      requestId,
      numScenarios: scenarios.length,
      numPaths
    });

    // Run stress tests
    const results = await mcEngine.runStressTests(portfolio, scenarios);

    recordApiRequest(routeKey, 'POST', 200, Date.now() - startTime);
    
    res.json({
      results,
      summary: {
        scenarios: results.length,
        worstCase: results.reduce((worst, r) => 
          r.var['99%'] > worst.var['99%'] ? r : worst
        ).scenario
      }
    });
  } catch (error) {
    logger.error('Stress test error', {
      requestId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    recordApiRequest(routeKey, 'POST', 500, Date.now() - startTime);
    
    res.status(500).json({
      error: 'Stress test failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/mc/validate
 * Validate VaR model with backtesting
 */
router.post('/validate', async (req, res) => {
  const requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  const startTime = Date.now();
  const routeKey = '/api/mc/validate';

  try {
    const { historicalReturns, varEstimates, confidenceLevel = 0.95 } = req.body;
    
    if (!Array.isArray(historicalReturns) || !Array.isArray(varEstimates)) {
      return res.status(400).json({
        error: 'historicalReturns and varEstimates must be arrays'
      });
    }
    
    if (historicalReturns.length !== varEstimates.length) {
      return res.status(400).json({
        error: 'Arrays must have the same length'
      });
    }
    
    logger.info('Validating VaR model', {
      requestId,
      dataPoints: historicalReturns.length,
      confidenceLevel
    });
    
    // Run validation
    const validation = await mcEngine.validateVaR(
      historicalReturns,
      varEstimates,
      confidenceLevel
    );

    recordApiRequest(routeKey, 'POST', 200, Date.now() - startTime);

    res.json({
      valid: validation.passes,
      pValue: validation.pValue,
      failureRate: validation.failureRate,
      interpretation: validation.passes
        ? 'VaR model is well-calibrated'
        : 'VaR model may need recalibration'
    });
  } catch (error) {
    logger.error('VaR validation error', {
      requestId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    recordApiRequest(routeKey, 'POST', 500, Date.now() - startTime);
    
    res.status(500).json({
      error: 'Validation failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/mc/health
 * Health check for Monte Carlo service
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'monte-carlo',
    timestamp: new Date().toISOString(),
    gpuAvailable: mcEngine['useGPU']
  });
});

export default router;
