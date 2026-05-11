import { Router } from 'express';
import { PaperTradingService, PaperTradeRequest, PaperTradeResponse, PositionResponse } from './paper-trading-service';
import { z } from 'zod';
import { getRequestId, logger } from '../logging/logger.js';
import { recordApiRequest } from '../observability/requestMetrics.js';

const paperTradingRouter = Router();
const paperTradingService = new PaperTradingService();

// Validation schemas
const paperTradeSchema = z.object({
  symbol: z.string().min(1, 'Symbol is required'),
  side: z.enum(['buy', 'sell'], { errorMap: () => ({ message: 'Side must be "buy" or "sell"' }) }),
  type: z.enum(['market', 'limit'], { errorMap: () => ({ message: 'Type must be "market" or "limit"' }) }),
  quantity: z.number().positive('Quantity must be positive'),
  price: z.number().positive('Price must be positive').optional(),
  stopLoss: z.number().positive('Stop loss must be positive').optional(),
  takeProfit: z.number().positive('Take profit must be positive').optional(),
  leverage: z.number().min(1, 'Leverage must be at least 1').max(100, 'Leverage must not exceed 100').optional().default(1),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK'], { errorMap: () => ({ message: 'Time in force must be GTC, IOC, or FOK' }) }),
  idempotencyKey: z.string().optional(),
});

const cancelTradeSchema = z.object({
  idempotencyKey: z.string().optional(),
});

// Middleware
paperTradingRouter.use((req, res, next) => {
  const start = process.hrtime.bigint();
  req.requestId = getRequestId(req.headers['x-request-id'] as string | string[] | undefined);
  res.setHeader('x-request-id', req.requestId);
  
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const routeKey = `${req.method} ${req.route?.path || req.path || req.originalUrl || req.url}`;
    recordApiRequest(routeKey, res.statusCode, durationMs);
    
    if (res.statusCode >= 500 || durationMs >= 1000) {
      logger.warn('Paper trading API request completed with warning', {
        requestId: req.requestId,
        route: routeKey,
        statusCode: res.statusCode,
        latencyMs: Number(durationMs.toFixed(2)),
      });
    }
  });
  
  next();
});

/**
 * @swagger
 * /api/paper/order:
 *   post:
 *     summary: Create a paper trading order
 *     description: Create a simulated trading order in the paper trading environment
 *     tags: [Paper Trading]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - symbol
 *               - side
 *               - type
 *               - quantity
 *               - timeInForce
 *             properties:
 *               symbol:
 *                 type: string
 *                 description: Trading pair symbol (e.g., BTC/USDT)
 *               side:
 *                 type: string
 *                 enum: [buy, sell]
 *                 description: Order side
 *               type:
 *                 type: string
 *                 enum: [market, limit]
 *                 description: Order type
 *               quantity:
 *                 type: number
 *                 description: Order quantity
 *                 minimum: 0.00000001
 *               price:
 *                 type: number
 *                 description: Order price (required for limit orders)
 *                 minimum: 0.00000001
 *               stopLoss:
 *                 type: number
 *                 description: Stop loss price
 *                 minimum: 0.00000001
 *               takeProfit:
 *                 type: number
 *                 description: Take profit price
 *                 minimum: 0.00000001
 *               leverage:
 *                 type: number
 *                 description: Leverage multiplier
 *                 minimum: 1
 *                 maximum: 100
 *                 default: 1
 *               timeInForce:
 *                 type: string
 *                 enum: [GTC, IOC, FOK]
 *                 description: Time in force
 *               idempotencyKey:
 *                 type: string
 *                 description: Unique key to prevent duplicate orders
 *     responses:
 *       200:
 *         description: Order created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   description: Order ID
 *                 status:
 *                   type: string
 *                   enum: [pending, filled, cancelled, expired]
 *                   description: Order status
 *                 symbol:
 *                   type: string
 *                   description: Trading pair symbol
 *                 side:
 *                   type: string
 *                   enum: [buy, sell]
 *                   description: Order side
 *                 quantity:
 *                   type: string
 *                   description: Order quantity
 *                 price:
 *                   type: string
 *                   description: Order price (if limit order)
 *                 filledQuantity:
 *                   type: string
 *                   description: Filled quantity (if filled)
 *                 fillPrice:
 *                   type: string
 *                   description: Fill price (if filled)
 *                 timestamp:
 *                   type: number
 *                   description: Order creation timestamp
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Internal server error
 */
paperTradingRouter.post('/order', async (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();

  try {
    const parsed = paperTradeSchema.safeParse(req.body);
    
    if (!parsed.success) {
      logger.warn('Paper trade validation failed', {
        requestId,
        issues: parsed.error.issues,
      });
      
      return res.status(400).json({
        error: 'Invalid request parameters',
        details: parsed.error.issues,
      });
    }

    const tradeRequest = parsed.data as PaperTradeRequest;
    
    // Validate limit order has price
    if (tradeRequest.type === 'limit' && !tradeRequest.price) {
      return res.status(400).json({
        error: 'Limit orders require a price',
      });
    }

    const result = await paperTradingService.createPaperTrade(tradeRequest);
    
    recordApiRequest('/api/paper/order', 'POST', 200, Date.now() - startTime);
    
    logger.info('Paper trade created', {
      requestId,
      orderId: result.id,
      symbol: result.symbol,
      side: result.side,
      quantity: result.quantity,
    });
    
    res.json(result);
  } catch (error: any) {
    recordApiRequest('/api/paper/order', 'POST', 500, Date.now() - startTime);
    
    logger.error('Failed to create paper trade', {
      requestId,
      error: error.message,
      stack: error.stack,
    });
    
    res.status(500).json({
      error: 'Failed to create paper trade',
      message: error.message,
    });
  }
});

/**
 * @swagger
 * /api/paper/order/{id}/cancel:
 *   put:
 *     summary: Cancel a paper trading order
 *     description: Cancel a pending paper trading order
 *     tags: [Paper Trading]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               idempotencyKey:
 *                 type: string
 *                 description: Unique key to prevent duplicate cancellations
 *     responses:
 *       200:
 *         description: Order cancelled successfully
 *       400:
 *         description: Invalid request or order cannot be cancelled
 *       404:
 *         description: Order not found
 *       500:
 *         description: Internal server error
 */
paperTradingRouter.put('/order/:id/cancel', async (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();
  const orderId = req.params.id;

  try {
    const parsed = cancelTradeSchema.safeParse(req.body);
    
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request parameters',
      });
    }

    const idempotencyKey = parsed.data.idempotencyKey;
    const result = await paperTradingService.cancelPaperTrade(orderId, idempotencyKey);
    
    recordApiRequest('/api/paper/order/{id}/cancel', 'PUT', 200, Date.now() - startTime);
    
    logger.info('Paper trade cancelled', {
      requestId,
      orderId,
    });
    
    res.json(result);
  } catch (error: any) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    
    recordApiRequest('/api/paper/order/{id}/cancel', 'PUT', statusCode, Date.now() - startTime);
    
    logger.error('Failed to cancel paper trade', {
      requestId,
      orderId,
      error: error.message,
    });
    
    res.status(statusCode).json({
      error: 'Failed to cancel paper trade',
      message: error.message,
    });
  }
});

/**
 * @swagger
 * /api/paper/positions:
 *   get:
 *     summary: Get open paper trading positions
 *     description: Retrieve all open paper trading positions
 *     tags: [Paper Trading]
 *     responses:
 *       200:
 *         description: List of open positions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Position ID
 *                   symbol:
 *                     type: string
 *                     description: Trading pair symbol
 *                   side:
 *                     type: string
 *                     enum: [buy, sell]
 *                     description: Position side
 *                   quantity:
 *                     type: string
 *                     description: Position quantity
 *                   entryPrice:
 *                     type: string
 *                     description: Entry price
 *                   currentPrice:
 *                     type: string
 *                     description: Current price (if available)
 *                   stopLoss:
 *                     type: string
 *                     description: Stop loss price (if set)
 *                   takeProfit:
 *                     type: string
 *                     description: Take profit price (if set)
 *                   leverage:
 *                     type: number
 *                     description: Leverage multiplier
 *                   status:
 *                     type: string
 *                     enum: [open, closed, liquidated]
 *                     description: Position status
 *                   unrealizedPnl:
 *                     type: string
 *                     description: Unrealized P&L
 *                   realizedPnl:
 *                     type: string
 *                     description: Realized P&L
 *                   pnlPercentage:
 *                     type: string
 *                     description: P&L percentage
 *                   roi:
 *                     type: string
 *                     description: Return on investment
 *                   openedAt:
 *                     type: number
 *                     description: Position open timestamp
 *                   closedAt:
 *                     type: number
 *                     description: Position close timestamp (if closed)
 *                   candlesHeld:
 *                     type: number
 *                     description: Number of candles held
 *                   exitReason:
 *                     type: string
 *                     description: Reason for exit (if closed)
 *       500:
 *         description: Internal server error
 */
paperTradingRouter.get('/positions', async (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();

  try {
    const positions = await paperTradingService.getOpenPositions();
    
    recordApiRequest('/api/paper/positions', 'GET', 200, Date.now() - startTime);
    
    logger.info('Retrieved open paper trading positions', {
      requestId,
      count: positions.length,
    });
    
    res.json(positions);
  } catch (error: any) {
    recordApiRequest('/api/paper/positions', 'GET', 500, Date.now() - startTime);
    
    logger.error('Failed to retrieve paper trading positions', {
      requestId,
      error: error.message,
    });
    
    res.status(500).json({
      error: 'Failed to retrieve paper trading positions',
      message: error.message,
    });
  }
});

/**
 * @swagger
 * /api/paper/positions/{id}:
 *   get:
 *     summary: Get a specific paper trading position
 *     description: Retrieve details of a specific paper trading position
 *     tags: [Paper Trading]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Position ID
 *     responses:
 *       200:
 *         description: Position details
 *       404:
 *         description: Position not found
 *       500:
 *         description: Internal server error
 */
paperTradingRouter.get('/positions/:id', async (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();
  const positionId = req.params.id;

  try {
    const position = await paperTradingService.getPosition(positionId);
    
    if (!position) {
      recordApiRequest('/api/paper/positions/{id}', 'GET', 404, Date.now() - startTime);
      return res.status(404).json({
        error: 'Position not found',
      });
    }
    
    recordApiRequest('/api/paper/positions/{id}', 'GET', 200, Date.now() - startTime);
    
    logger.info('Retrieved paper trading position', {
      requestId,
      positionId,
    });
    
    res.json(position);
  } catch (error: any) {
    recordApiRequest('/api/paper/positions/{id}', 'GET', 500, Date.now() - startTime);
    
    logger.error('Failed to retrieve paper trading position', {
      requestId,
      positionId,
      error: error.message,
    });
    
    res.status(500).json({
      error: 'Failed to retrieve paper trading position',
      message: error.message,
    });
  }
});

/**
 * @swagger
 * /api/paper/summary:
 *   get:
 *     summary: Get paper trading summary
 *     description: Retrieve summary of all paper trading activity
 *     tags: [Paper Trading]
 *     responses:
 *       200:
 *         description: Paper trading summary
 *       500:
 *         description: Internal server error
 */
paperTradingRouter.get('/summary', async (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();

  try {
    const summary = await paperTradingService.getSummary();
    
    recordApiRequest('/api/paper/summary', 'GET', 200, Date.now() - startTime);
    
    logger.info('Retrieved paper trading summary', {
      requestId,
      positionCount: summary.positionCount.total,
    });
    
    res.json(summary);
  } catch (error: any) {
    recordApiRequest('/api/paper/summary', 'GET', 500, Date.now() - startTime);
    
    logger.error('Failed to retrieve paper trading summary', {
      requestId,
      error: error.message,
    });
    
    res.status(500).json({
      error: 'Failed to retrieve paper trading summary',
      message: error.message,
    });
  }
});

/**
 * @swagger
 * /api/paper/orderbook/{symbol}:
 *   get:
 *     summary: Get order book snapshot
 *     description: Retrieve current order book snapshot for a symbol
 *     tags: [Paper Trading]
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: Trading pair symbol
 *     responses:
 *       200:
 *         description: Order book snapshot
 *       404:
 *         description: Symbol not found
 *       500:
 *         description: Internal server error
 */
paperTradingRouter.get('/orderbook/:symbol', async (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();
  const symbol = req.params.symbol;

  try {
    const snapshot = paperTradingService.getOrderBookSnapshot(symbol);
    
    if (!snapshot) {
      recordApiRequest('/api/paper/orderbook/{symbol}', 'GET', 404, Date.now() - startTime);
      return res.status(404).json({
        error: 'Symbol not found',
      });
    }
    
    recordApiRequest('/api/paper/orderbook/{symbol}', 'GET', 200, Date.now() - startTime);
    
    res.json(snapshot);
  } catch (error: any) {
    recordApiRequest('/api/paper/orderbook/{symbol}', 'GET', 500, Date.now() - startTime);
    
    logger.error('Failed to retrieve order book snapshot', {
      requestId,
      symbol,
      error: error.message,
    });
    
    res.status(500).json({
      error: 'Failed to retrieve order book snapshot',
      message: error.message,
    });
  }
});

export default paperTradingRouter;
