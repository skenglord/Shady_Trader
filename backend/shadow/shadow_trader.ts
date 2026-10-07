import { enforceDegenDollarCap, enforceRiskCap, getDailyRealizedLoss, RiskMode, RiskManager, validateModeForLive } from '../risk/manager.js';
import { runQuery } from '../database.js';
import { randomUUID } from 'crypto';
import { CostEstimator, OrderRequest, SlippageCircuitBreaker } from '../slippage/index.js';
import { computeFill } from '../slippage/fillCalculator.js';
import { Decimal } from 'decimal.js';
import { logger } from '../logging/logger.js';
import { calculateTradePnl } from './pnl.js';

type ExitDecision = { exitPrice: number; reason: string; pnlOverride?: number };
type RatchetUpdate = { trailingStopApplied: boolean; runnerTriggered: boolean } | null;
type ExitContext = {
  currentPrice: number;
  config: any;
  mode: RiskMode;
  leverage: number;
  marginUsed: number;
  currentMargin: number;
  profitPct: number;
  maintenanceMargin: number;
  activeMode?: string;
  balanceManager?: any;
  portfolio: { balance: number; initialBalance: number; openTrades: any[] };
};

function requireFilledOrder(order: any, expectedAmount: number): void {
  const status = String(order?.status || '').toLowerCase();
  const filled = Number(order?.filled);
  const tolerance = Math.max(1e-12, expectedAmount * 1e-8);
  if (!order?.id || !['filled', 'closed'].includes(status) || !Number.isFinite(filled) || filled + tolerance < expectedAmount) {
    throw new Error(`Exchange did not confirm a full market fill${status ? ` (${status}, filled ${Number.isFinite(filled) ? filled : 'unknown'})` : ''}`);
  }
}

async function canOpenNewTrade({
  riskManager, mode, activeMode, portfolio, currentPrice, exchange
}: {
  riskManager: RiskManager;
  mode: RiskMode;
  activeMode?: string;
  portfolio: { balance: number; initialBalance: number; openTrades: any[] };
  currentPrice: number;
  exchange?: any;
}): Promise<boolean> {
  const unresolved = await runQuery(
    `SELECT idempotency_key FROM execution_intents
     WHERE status IN ('pending', 'submitted', 'uncertain') LIMIT 1`,
    [], 'all'
  );
  if (Array.isArray(unresolved) && unresolved.length > 0) {
    logger.error('Entry blocked by unresolved execution intent', { service: 'ShadowTrader', mode });
    return false;
  }

  let dailyLoss: number;
  try {
    dailyLoss = await getDailyRealizedLoss(mode, Date.now(), currentPrice);
  } catch (error) {
    logger.error('Entry blocked: daily realized loss could not be read', {
      service: 'ShadowTrader', mode, error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }

  if (mode === activeMode && process.env.LIVE_TRADING_ENABLED === 'true') {
    try {
      validateModeForLive(mode);
    } catch (error) {
      logger.error('Live entry blocked by risk mode guard', {
        service: 'ShadowTrader', mode, error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
    if (!(exchange?.hasExecutionCredentials ?? Boolean(exchange?.apiKey && exchange?.apiSecret))) {
      logger.error('Live entry blocked: exchange credentials are incomplete', { service: 'ShadowTrader', mode });
      return false;
    }
  }

  const haltReason = riskManager.checkCircuitBreakers(
    portfolio.balance, portfolio.initialBalance, dailyLoss, mode
  );
  if (haltReason) {
    console.log(`Shadow Trader [${mode}]: Halted - ${haltReason}. Effective Balance: ${portfolio.balance}, Initial: ${portfolio.initialBalance}`);
    return false;
  }
  return true;
}

export class ShadowTrader {
  portfolios: Record<RiskMode, { balance: number, initialBalance: number, openTrades: any[] }>;
  riskManager: RiskManager;
  costEstimator?: CostEstimator;
  slippageCircuitBreaker?: SlippageCircuitBreaker;
  private runnerStates: Map<string, { tradeId: string, originalAmount: number, remainingAmount: number, partialExits: number, maxPartialExits: number, lastExitPrice: number, cumulativeExited: number }> = new Map();

  constructor() {
    this.portfolios = {
      [RiskMode.ULTRA_CONSERVATIVE]: { balance: 100000, initialBalance: 100000, openTrades: [] },
      [RiskMode.CONSERVATIVE]: { balance: 100000, initialBalance: 100000, openTrades: [] },
      [RiskMode.MODERATE]: { balance: 100000, initialBalance: 100000, openTrades: [] },
      [RiskMode.AGGRESSIVE]: { balance: 100000, initialBalance: 100000, openTrades: [] },
      [RiskMode.DEGEN]: { balance: 100000, initialBalance: 100000, openTrades: [] },
      [RiskMode.AI_ENHANCED]: { balance: 100000, initialBalance: 100000, openTrades: [] }
    };
    this.riskManager = new RiskManager();
  }

  private async logAuditTrade(
    tradeId: string,
    eventType: string,
    riskMode: string,
    leverage: number,
    symbol: string,
    side: string,
    amount: number,
    price: number,
    exitReason?: string,
    pnl?: number,
    metadata?: any
  ) {
    try {
      const auditId = randomUUID();
      const timestamp = Date.now();
      const metadataJson = metadata ? JSON.stringify(metadata) : null;

      await runQuery(`
        INSERT INTO audit_trades (id, trade_id, event_type, timestamp, risk_mode, leverage, symbol, side, amount, price, exit_reason, pnl, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [auditId, tradeId, eventType, timestamp, riskMode, leverage, symbol, side, amount, price, exitReason || null, pnl || null, metadataJson]);
    } catch (error) {
      console.error(`Failed to log audit trade ${tradeId}:`, error);
      // Don't throw - audit logging shouldn't break trading
    }
  }

  async init() {
    await this.loadState();
  }

  async reset() {
    // Don't delete trade history — just reset in-memory portfolios
    for (const mode of Object.values(RiskMode)) {
      this.portfolios[mode as RiskMode] = { balance: 100000, initialBalance: 100000, openTrades: [] };
      console.log(`[ShadowTrader] Resetting ${mode} to 100000`);
    }
  }

  async loadState() {
    let liveOrderIds = new Map<string, string>();
    try {
      const intents = await runQuery(
        `SELECT trade_id, exchange_order_id FROM execution_intents WHERE status = 'complete' AND exchange_order_id IS NOT NULL`,
        [], 'all'
      );
      liveOrderIds = new Map((intents || []).map((intent: any) => [String(intent.trade_id), String(intent.exchange_order_id)]));
    } catch (error) {
      logger.error('Failed to load persisted live order ids', {
        service: 'ShadowTrader', error: error instanceof Error ? error.message : String(error)
      });
    }
    for (const mode of Object.values(RiskMode)) {
      let openTrades: any[] = [];
      try {
        openTrades = await runQuery(`
        SELECT * FROM shadow_trades
        WHERE risk_mode = ? AND status = 'open'
      `, [mode], 'all');
      } catch {
        openTrades = [];
      }
      
      this.portfolios[mode].openTrades = openTrades.map((t: any) => ({
        ...t,
        stopLoss: t.stop_loss,
        takeProfit: t.take_profit,
        exchangeOrderId: liveOrderIds.get(String(t.id)) || t.exchange_order_id || null
      }));

      let result: any[] = [];
      try {
        result = await runQuery(`
        SELECT SUM(pnl) as totalPnl FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed'
      `, [mode], 'all');
      } catch {
        result = [];
      }
      
      const totalPnl = result[0]?.totalPnl || 0;
      this.portfolios[mode].balance = this.portfolios[mode].initialBalance + totalPnl;
    }
  }

  async processSignal(
    signal: any,
    currentPrice: number,
    activeMode?: string,
    balanceManager?: any,
    exchange?: any,
    regime: string = 'uncertain',
    candleTime?: number
  ): Promise<boolean> {
    let activeModeTradeOpened = false;
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      const liveOrderEnabled = mode === activeMode && process.env.LIVE_TRADING_ENABLED === 'true';

      if (!await canOpenNewTrade({
        riskManager: this.riskManager, mode, activeMode, portfolio, currentPrice, exchange
      })) continue;

      const balances = balanceManager ? await balanceManager.getBalances() : null;
      // Use portfolio's own balance for state checks, botBalance for position sizing only
      const effectiveBalance = portfolio.balance;

      if (mode === activeMode) {
        console.log(`[ShadowTrader] Debug ${mode}: effectiveBalance=${effectiveBalance}, portfolio.balance=${portfolio.balance}, botBalance=${balances?.botBalance}, activeMode=${activeMode}`);
      }

      // Check circuit breakers
      // Validate trade
      if (!this.riskManager.validateTrade(signal, mode, portfolio.openTrades.length, regime)) {
        continue;
      }

      // Calculate position size with dynamic multiplier from MD Part 5.1
      let positionSize = this.riskManager.calculatePositionSize(effectiveBalance, signal.entryPrice, signal.stopLoss, mode as RiskMode, signal.confidence);
      if (positionSize <= 0) continue;

      // Cost estimation and circuit breaker check for active mode
      let estSlippageFrac = parseFloat(process.env.SLIPPAGE_BASE_FRAC ?? '0.0005');
      if (mode === activeMode && this.costEstimator && this.slippageCircuitBreaker) {
        const orderRequest: OrderRequest = {
          symbol: signal.symbol,
          side: signal.side as 'buy' | 'sell',
          size: new Decimal(positionSize),
          type: 'market',
          timeInForce: 'GTC'
        };

        const costEstimate = await this.costEstimator.estimateTotalCost(orderRequest);
        estSlippageFrac = costEstimate.breakdown.slippage.totalSlippage.toNumber();
        const marketState = {
          timestamp: Date.now(),
          midPrice: new Decimal(signal.entryPrice),
          spread: new Decimal(0.00006), // 0.006% spread ratio (below 5x threshold of 0.0001 baseline)
          volatility: 0.02, // Mock volatility
          depth: {
            bidVolume: new Decimal(1000),
            askVolume: new Decimal(1000),
            bidLevels: 10,
            askLevels: 10,
            totalDepth: new Decimal(2000), // bidVolume + askVolume
            vpin: 0.1
          },
          regime: 'normal' as any
        };

        const breakerAction = this.slippageCircuitBreaker.evaluateBreaker(costEstimate, marketState);

        if (breakerAction.action === 'reject') {
          console.log(`Shadow Trader [${mode}]: Trade rejected by circuit breaker - ${breakerAction.reason}`);
          continue;
        }

        if (breakerAction.action === 'delay') {
          console.log(`Shadow Trader [${mode}]: Trade delayed by circuit breaker - ${breakerAction.reason}`);
          // In production, would implement delay logic
          continue;
        }

        if (breakerAction.action === 'scale_down' && breakerAction.scaleFactor) {
          positionSize *= breakerAction.scaleFactor;
          console.log(`Shadow Trader [${mode}]: Position size scaled down to ${positionSize} - ${breakerAction.reason}`);
        }
      }

      // Adjust TP/SL based on mode config
      const config = this.riskManager.getConfig(mode as RiskMode);
      // All current authenticated exchange adapters submit spot orders and do
      // not configure exchange leverage. Never send a simulated leveraged size
      // to those spot endpoints.
      if (liveOrderEnabled && Number(config.leverage || 1) !== 1) {
        logger.error('Live entry blocked: current exchange adapters support spot sizing only', {
          service: 'ShadowTrader', mode, configuredLeverage: config.leverage
        });
        continue;
      }

      // Part 5.2: Dynamic Stops (ATR-based)
      // Since we have ATR in candles, let's use it if available
      // For now, using percentage from config as fallback
      const slPct = (config.stopLoss || 2.0) / 100;
      const tpPct = (config.takeProfit || 1.5) / 100;

      const adjustedStopLoss = signal.side === 'buy' 
        ? signal.entryPrice * (1 - slPct)
        : signal.entryPrice * (1 + slPct);
      const adjustedTakeProfit = signal.side === 'buy'
        ? signal.entryPrice * (1 + tpPct)
        : signal.entryPrice * (1 - tpPct);

      // Convert the calculated quantity back to an equity fraction, apply the
      // configured effective-risk ceiling (including estimated entry/exit
      // costs), then convert the capped fraction back to exchange base units.
      try {
        const leverage = Number(config.leverage || 1);
        const stopFrac = Math.abs(signal.entryPrice - adjustedStopLoss) / signal.entryPrice;
        const feeRate = Number(process.env.TAKER_FEE_RATE ?? '0.0006');
        if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 0.1) throw new Error('Invalid TAKER_FEE_RATE');
        const allInStopFrac = stopFrac + (2 * Math.max(0, estSlippageFrac)) + (2 * feeRate);
        const equityFraction = positionSize * signal.entryPrice / (effectiveBalance * leverage);
        let cappedFraction = enforceRiskCap(equityFraction, leverage, allInStopFrac);
        cappedFraction = enforceDegenDollarCap(mode, cappedFraction, effectiveBalance, allInStopFrac, leverage);
        positionSize = (cappedFraction * effectiveBalance * leverage) / signal.entryPrice;
        if (!Number.isFinite(positionSize) || positionSize <= 0) continue;
      } catch (error) {
        logger.error('Entry blocked: risk cap could not be applied', {
          service: 'ShadowTrader', mode, error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      // Block 7: realistic slippage-adjusted fill (fractions only)
      const fill = computeFill(signal.side as 'buy' | 'sell', currentPrice, tpPct, estSlippageFrac);
      if (fill.skipped) {
        console.log(`Shadow Trader [${mode}]: Trade skipped - ${fill.skipReason}`);
        continue;
      }

      // Execute shadow trade
      const trade = {
        id: `shadow-${mode}-${Date.now()}-${randomUUID()}`,
        symbol: signal.symbol,
        side: signal.side,
        amount: positionSize,
        price: fill.fillPrice,
        status: liveOrderEnabled ? 'pending' : 'open',
        timestamp: Date.now(),
        risk_mode: mode,
        stopLoss: adjustedStopLoss,
        takeProfit: adjustedTakeProfit,
        initialStopLoss: adjustedStopLoss, // Save for trailing logic
        leverage: config.leverage || 1,
        candlesHeld: 0,
        isRunner: false,
        entrySlippageFrac: fill.slippageFrac,
        totalFeeFrac: fill.feeFrac,
        exchangeOrderId: null as string | null
      };

      // Check if trade cost exceeds bot balance for active mode
      const tradeCost = trade.amount * trade.price / (liveOrderEnabled ? 1 : trade.leverage);
      if (mode === activeMode && balances && tradeCost > balances.botBalance) {
        console.log(`Shadow Trader [${mode}]: Trade rejected - Insufficient bot balance. Cost: ${tradeCost}, Bot: ${balances.botBalance}`);
        continue;
      }

      const intentCandleTime = Number.isFinite(candleTime) ? Number(candleTime) : trade.timestamp;
      const idempotencyKey = `${mode}:${trade.symbol}:${trade.side}:${intentCandleTime}`;
      const intentResult = await runQuery(`
        INSERT INTO execution_intents
          (idempotency_key, trade_id, symbol, risk_mode, side, candle_time, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `, [idempotencyKey, trade.id, trade.symbol, mode, trade.side, intentCandleTime,
        liveOrderEnabled ? 'pending' : 'simulated', trade.timestamp, trade.timestamp], 'run');
      if (intentResult?.changes === 0 || intentResult?.rowCount === 0) continue;

      // Persist the pending position before contacting the exchange. If the
      // process dies or times out, the durable intent blocks another entry.
      await runQuery(`
        INSERT INTO shadow_trades (id, symbol, side, amount, price, status, timestamp, risk_mode, leverage, stop_loss, take_profit, entry_slippage_frac, total_fee_frac)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [trade.id, trade.symbol, trade.side, trade.amount, trade.price, trade.status, trade.timestamp, trade.risk_mode, trade.leverage, trade.stopLoss, trade.takeProfit, trade.entrySlippageFrac, trade.totalFeeFrac]);

      if (liveOrderEnabled) {
        try {
          const order = await exchange.placeOrder(trade.symbol, trade.side, trade.amount, 'market');
          requireFilledOrder(order, trade.amount);
          trade.exchangeOrderId = order.id;
          await runQuery(`UPDATE execution_intents SET status = 'submitted', exchange_order_id = ?, updated_at = ? WHERE idempotency_key = ?`,
            [order.id, Date.now(), idempotencyKey]);
          await runQuery(`UPDATE shadow_trades SET status = 'open' WHERE id = ?`, [trade.id]);
          await runQuery(`UPDATE execution_intents SET status = 'complete', updated_at = ? WHERE idempotency_key = ?`,
            [Date.now(), idempotencyKey]);
          trade.status = 'open';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await runQuery(`UPDATE execution_intents SET status = 'uncertain', last_error = ?, updated_at = ? WHERE idempotency_key = ?`,
            [message.slice(0, 1000), Date.now(), idempotencyKey]);
          logger.error('Live order outcome is uncertain; entry remains blocked pending reconciliation', {
            service: 'ShadowTrader', tradeId: trade.id, idempotencyKey, error: message
          });
          continue;
        }
      } else {
        await runQuery(`UPDATE execution_intents SET status = 'complete', updated_at = ? WHERE idempotency_key = ?`,
          [Date.now(), idempotencyKey]);
      }

      portfolio.openTrades.push(trade);
      if (mode === activeMode) activeModeTradeOpened = true;

      if (mode === activeMode && balanceManager) {
        await balanceManager.addActiveTrade(trade.amount * trade.price / (liveOrderEnabled ? 1 : trade.leverage));
      }

       // Audit log: trade open
       await this.logAuditTrade(
         trade.id,
         'open',
         trade.risk_mode,
         trade.leverage,
         trade.symbol,
         trade.side,
         trade.amount,
         trade.price,
         undefined,
         undefined,
         { stopLoss: trade.stopLoss, takeProfit: trade.takeProfit, confidence: signal.confidence, regime }
       );
    }
    return activeModeTradeOpened;
  }

  private async evaluateRatchet(trade: any, ctx: ExitContext): Promise<RatchetUpdate> {
    let trailingStopApplied = false;
    let runnerTriggered = false;

    if (trade.side === 'buy') {
      if (ctx.config.multiCandleHoldEnabled && ctx.profitPct > 0.005) {
        const trailStop = ctx.currentPrice * 0.996;
        if (trailStop > trade.stopLoss) {
          trade.stopLoss = trailStop;
          trailingStopApplied = true;
        }
      }

      if (ctx.config.runnerEnabled && !trade.isRunner && ctx.profitPct >= (ctx.config.runnerConditions?.triggerProfit / 100 || 0.015)) {
        console.log(`[ShadowTrader] [${ctx.mode}] Runner triggered for ${trade.id}`);
        const exitFactor = ctx.config.runnerConditions?.partialExit || 0.6;
        const closeAmount = trade.amount * exitFactor;
        const partialPnl = calculateTradePnl({ ...trade, amount: closeAmount }, ctx.currentPrice);

        ctx.portfolio.balance += partialPnl;
        trade.amount -= closeAmount;
        trade.isRunner = true;
        trade.stopLoss = Math.max(trade.stopLoss, trade.price * 1.005);

        if (ctx.mode === ctx.activeMode && ctx.balanceManager) {
          const tradeCost = closeAmount * trade.price / trade.leverage;
          ctx.balanceManager.recordTradeResult(partialPnl, tradeCost);
        }

        await this.logAuditTrade(
          trade.id,
          'partial_exit',
          ctx.mode,
          trade.leverage,
          trade.symbol,
          trade.side,
          closeAmount,
          ctx.currentPrice,
          'runner',
          partialPnl,
          { remainingAmount: trade.amount, totalExited: closeAmount, profitPct: ctx.profitPct }
        );
        runnerTriggered = true;
      }
    } else {
      if (ctx.config.multiCandleHoldEnabled && ctx.profitPct > 0.005) {
        const trailStop = ctx.currentPrice * 1.004;
        if (trailStop < trade.stopLoss) {
          trade.stopLoss = trailStop;
          trailingStopApplied = true;
        }
      }
    }

    if (!trailingStopApplied && !runnerTriggered) return null;
    return { trailingStopApplied, runnerTriggered };
  }

  private evaluateStopLoss(trade: any, ctx: ExitContext): ExitDecision | null {
    const lossPct = (ctx.marginUsed - ctx.currentMargin) / ctx.marginUsed;
    const liquidationThreshold = (1 / ctx.leverage) - ctx.maintenanceMargin;

    if (lossPct >= liquidationThreshold) {
      return { exitPrice: ctx.currentPrice, reason: 'liquidation', pnlOverride: -ctx.marginUsed };
    }

    if (trade.side === 'buy') {
      if (ctx.currentPrice <= trade.stopLoss) {
        return { exitPrice: ctx.currentPrice, reason: 'stop_loss' };
      }
    } else {
      if (ctx.currentPrice >= trade.stopLoss) {
        return { exitPrice: ctx.currentPrice, reason: 'stop_loss' };
      }
    }

    return null;
  }

  private evaluateTakeProfit(trade: any, ctx: ExitContext): ExitDecision | null {
    let decision: ExitDecision | null = null;

    if (ctx.config.earlyExitEnabled && ctx.profitPct >= (ctx.config.earlyExitTarget / 100)) {
      decision = { exitPrice: ctx.currentPrice, reason: 'early_exit' };
    }

    if (trade.side === 'buy') {
      if (ctx.currentPrice >= trade.takeProfit && !trade.isRunner) {
        decision = { exitPrice: ctx.currentPrice, reason: 'take_profit' };
      }
    } else {
      if (ctx.currentPrice <= trade.takeProfit && !trade.isRunner) {
        decision = { exitPrice: ctx.currentPrice, reason: 'take_profit' };
      }
    }

    return decision;
  }

  private evaluateMlExitCheckpoints(trade: any, ctx: ExitContext): ExitDecision | null {
    if (ctx.config.multiCandleHoldEnabled && trade.candlesHeld >= (ctx.config.holdConditions?.maxCandles || 3)) {
      return { exitPrice: ctx.currentPrice, reason: 'multi_candle_expiry' };
    }
    return null;
  }

  private async executeTradeClosure(
    trade: any,
    exitDecision: ExitDecision,
    pnlRef: { value: number },
    ctx: ExitContext,
    exchange?: any
  ): Promise<boolean> {
    if (trade.exchangeOrderId) {
      if (!(exchange?.hasExecutionCredentials ?? Boolean(exchange?.apiKey && exchange?.apiSecret))) {
        logger.error('Live close blocked: exchange credentials are incomplete', { service: 'ShadowTrader', tradeId: trade.id });
        return false;
      }
      try {
        const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
        const order = await exchange.placeOrder(trade.symbol, closeSide, trade.amount, 'market');
        requireFilledOrder(order, trade.amount);
        trade.exchangeCloseOrderId = order.id;
      } catch (error) {
        logger.error('Live close failed; position remains open for recovery', {
          service: 'ShadowTrader', tradeId: trade.id, error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    }
    if (exitDecision.pnlOverride !== undefined) {
      pnlRef.value = exitDecision.pnlOverride;
    }

    const pnl = pnlRef.value;
    ctx.portfolio.balance += pnl;

    if (pnl > 0) {
      this.riskManager.recordWin(ctx.mode);
    } else {
      this.riskManager.recordLoss(ctx.mode);
    }

    if (ctx.mode === ctx.activeMode && ctx.balanceManager) {
      const tradeCost = trade.amount * trade.price / trade.leverage;
      ctx.balanceManager.recordTradeResult(pnl, tradeCost);

    }

    await runQuery(`
      UPDATE shadow_trades
      SET status = 'closed', pnl = ?, exit_price = ?, exit_timestamp = ?
      WHERE id = ?
    `, [pnl, ctx.currentPrice, Date.now(), trade.id]);

    await this.logAuditTrade(
      trade.id,
      'close',
      ctx.mode,
      trade.leverage,
      trade.symbol,
      trade.side,
      trade.amount,
      ctx.currentPrice,
      exitDecision.reason,
      pnl,
      { candlesHeld: trade.candlesHeld, profitPct: ctx.profitPct, liquidationThreshold: ctx.leverage ? 1 / ctx.leverage - ctx.maintenanceMargin : null }
    );

    console.log(`Shadow Trader [${ctx.mode}]: Trade ${trade.id} closed due to ${exitDecision.reason}. PnL: ${pnl.toFixed(2)}`);
    return true;
  }

  async updatePositions(currentPrice: number, activeMode?: string, balanceManager?: any, exchange?: any, lastCandle: any = null) {
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      const newOpenTrades = [];
      const config = this.riskManager.getConfig(mode as RiskMode);
      const maintenanceMargin = 0.005;

      for (const trade of portfolio.openTrades) {
        if (lastCandle && (!trade.lastUpdateTime || lastCandle.time > trade.lastUpdateTime)) {
          trade.candlesHeld = (trade.candlesHeld || 0) + 1;
          trade.lastUpdateTime = lastCandle.time;
        }

        console.log(`[ShadowTrader] Checking trade ${trade.id} for ${mode}. Price: ${currentPrice}, SL: ${trade.stopLoss}, TP: ${trade.takeProfit}`);
        const leverage = trade.leverage || config.leverage || 1;
        const marginUsed = trade.amount * trade.price / leverage;
        const currentNotional = trade.amount * currentPrice;
        const currentMargin = currentNotional / leverage;
        const pnl = calculateTradePnl(trade, currentPrice);
        const profitPct = trade.side === 'buy'
          ? (currentPrice - trade.price) / trade.price
          : (trade.price - currentPrice) / trade.price;

        const ctx: ExitContext = {
          currentPrice, config, mode: mode as RiskMode, leverage, marginUsed, currentMargin,
          profitPct, maintenanceMargin, activeMode, balanceManager, portfolio
        };

        // 1. Ratchet: trailing stop + runner (mutates trade, side effects)
        await this.evaluateRatchet(trade, ctx);

        // 2. Take profit / early exit (lowest precedence — can be overridden)
        let exitDecision: ExitDecision | null = this.evaluateTakeProfit(trade, ctx);

        // 3. Stop loss / liquidation (overrides TP / early_exit)
        const slDecision = this.evaluateStopLoss(trade, ctx);
        if (slDecision) {
          exitDecision = slDecision;
        }

        // 4. ML checkpoints / multi-candle expiry (highest precedence)
        const mlDecision = this.evaluateMlExitCheckpoints(trade, ctx);
        if (mlDecision) {
          exitDecision = mlDecision;
        }

        if (exitDecision) {
          const pnlRef = { value: pnl };
          const closed = await this.executeTradeClosure(trade, exitDecision, pnlRef, ctx, exchange);
          if (!closed) newOpenTrades.push(trade);
        } else {
          newOpenTrades.push(trade);
        }
      }

      portfolio.openTrades = newOpenTrades;
    }
  }

    async closeTrade(tradeId: string, currentPrice: number, activeMode?: string, balanceManager?: any, exchange?: any) {
     for (const mode of Object.values(RiskMode)) {
       const portfolio = this.portfolios[mode];
       const tradeIndex = portfolio.openTrades.findIndex(t => t.id === tradeId);
       
       if (tradeIndex !== -1) {
         const trade = portfolio.openTrades[tradeIndex];
         if (trade.exchangeOrderId) {
           if (!(exchange?.hasExecutionCredentials ?? Boolean(exchange?.apiKey && exchange?.apiSecret))) {
             logger.error('Live close blocked: exchange credentials are incomplete', { service: 'ShadowTrader', tradeId });
             return false;
           }
           try {
             const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
             const order = await exchange.placeOrder(trade.symbol, closeSide, trade.amount, 'market');
             requireFilledOrder(order, trade.amount);
           } catch (error) {
             logger.error('Live close failed; position remains open for recovery', {
               service: 'ShadowTrader', tradeId, error: error instanceof Error ? error.message : String(error)
             });
             return false;
           }
         }
         const leverage = trade.leverage || 1;
         const marginUsed = trade.amount * trade.price / leverage;
         const currentNotional = trade.amount * currentPrice;
         const currentMargin = currentNotional / leverage;
         const pnl = calculateTradePnl(trade, currentPrice);

         portfolio.balance += pnl;
         
         // Record win/loss for circuit breaker tracking
         if (pnl > 0) {
           this.riskManager.recordWin(mode);
         } else {
           this.riskManager.recordLoss(mode);
         }
         
         if (mode === activeMode && balanceManager) {
           const tradeCost = trade.amount * trade.price / trade.leverage;
           balanceManager.recordTradeResult(pnl, tradeCost);
           
         }

          const result = await runQuery(`
            UPDATE shadow_trades
            SET status = 'closed', pnl = ?, exit_price = ?, exit_timestamp = ?
            WHERE id = ?
          `, [pnl, currentPrice, Date.now(), trade.id]);

          // Audit log: trade close (manual)
          await this.logAuditTrade(
            trade.id,
            'close',
            mode,
            trade.leverage,
            trade.symbol,
            trade.side,
            trade.amount,
            currentPrice,
            'manual_close',
            pnl,
            { candlesHeld: trade.candlesHeld }
          );

          portfolio.openTrades.splice(tradeIndex, 1);
         return true;
       }
     }
     return false;
   }

  async updateTradeParams(tradeId: string, stopLoss: number, takeProfit: number) {
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      const trade = portfolio.openTrades.find(t => t.id === tradeId);
      
      if (trade) {
        trade.stopLoss = stopLoss;
        trade.takeProfit = takeProfit;
        
        await runQuery(`
          UPDATE shadow_trades
          SET stop_loss = ?, take_profit = ?
          WHERE id = ?
        `, [stopLoss, takeProfit, tradeId]);
        return true;
      }
    }
    return false;
  }

  async getPerformance() {
    const performance: any = {};
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];

      const stats = await runQuery(
        `SELECT COUNT(*) as count, COALESCE(SUM(pnl), 0) as totalPnl
        FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed'
      `,
        [mode],
        'all'
      );
      const stat = stats[0] || { count: 0, totalPnl: 0 };

      const wins = await runQuery(
        `SELECT COUNT(*) as count
        FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed' AND pnl > 0
      `,
        [mode],
        'all'
      );

      // Get history
      const closedTrades = await runQuery(`
        SELECT exit_timestamp as time, pnl
        FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed'
        ORDER BY exit_timestamp ASC
      `, [mode], 'all');
      
      let currentBalance = portfolio.initialBalance;
      const history = [{ time: Date.now() - 24 * 60 * 60 * 1000, balance: currentBalance }]; // Start 24h ago
      
      for (const t of closedTrades) {
        currentBalance += t.pnl;
        history.push({ time: t.time, balance: currentBalance });
      }
      
      // Add current point
      history.push({ time: Date.now(), balance: portfolio.balance });

      // The `wins` query above (line ~573) computes the count of closed
      // shadow trades with pnl > 0 for this risk mode. Bind its result here
      // so the winRate calculation below can use it. Defensive defaults: if
      // `wins` somehow came back empty (e.g. partial DB failure), default to 0.
      const winCount = wins[0]?.count ?? 0;
      const winRate = stat.count > 0 ? winCount / stat.count : 0;
      const totalPnl = stat.totalPnl || 0;
      const roi = ((portfolio.balance - portfolio.initialBalance) / portfolio.initialBalance) * 100;

      performance[mode] = {
        balance: portfolio.balance,
        roi: roi,
        winRate: winRate * 100,
        tradesCount: stat.count,
        totalPnl: totalPnl,
        history: history
      };
    }
    return performance;
  }
}
