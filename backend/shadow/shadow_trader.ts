import { enforceDegenDollarCap, enforceRiskCap, getDailyRealizedLoss, RiskMode, RiskManager, validateModeForLive } from '../risk/manager.js';
import { runQuery, withDatabaseTransaction } from '../database.js';
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
  riskManager, mode, activeMode, portfolio, resolvePrice, exchange
}: {
  riskManager: RiskManager;
  mode: RiskMode;
  activeMode?: string;
  portfolio: { balance: number; initialBalance: number; openTrades: any[] };
  resolvePrice: (symbol: string) => Promise<number>;
  exchange?: any;
}): Promise<boolean> {
  const isLiveEntry = mode === activeMode && process.env.LIVE_TRADING_ENABLED === 'true';
  if (isLiveEntry) {
    const account = exchange?.accountExecutionAdapter;
    if (!account) return false;
    const unresolved = await runQuery(
      `SELECT idempotency_key FROM execution_intents
       WHERE exchange_name = ? AND account_id = ? AND status IN ('pending', 'submitted', 'uncertain', 'partially_filled') LIMIT 1`,
      [account.exchange, account.accountId], 'all'
    );
    if (Array.isArray(unresolved) && unresolved.length > 0) {
      logger.error('Entry blocked by unresolved execution intent for the live account', { service: 'ShadowTrader', mode });
      return false;
    }
  }

  let dailyLoss: number;
  try {
    dailyLoss = await getDailyRealizedLoss(mode, Date.now(), resolvePrice);
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
    if (!exchange?.accountExecutionAdapter || typeof exchange?.isAccountReadyForLiveTrading !== 'function' || !(await exchange.isAccountReadyForLiveTrading())) {
      logger.error('Live entry blocked: exchange account reconciliation is not ready', { service: 'ShadowTrader', mode });
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
  private closingTradeIds = new Set<string>();

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

  async loadState(scope?: { exchange: string; accountId: string }) {
    let liveOrderIds = new Map<string, string>();
    try {
      const intents = await runQuery(
        `SELECT trade_id, exchange_order_id FROM execution_intents WHERE status IN ('complete','partially_filled') AND intent_type = 'entry' AND exchange_order_id IS NOT NULL`,
        [], 'all'
      );
      liveOrderIds = new Map((intents || []).map((intent: any) => [String(intent.trade_id), String(intent.exchange_order_id)]));
    } catch (error) {
      logger.error('Failed to load persisted live order ids; refusing to start from incomplete state', {
        service: 'ShadowTrader', error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    for (const mode of Object.values(RiskMode)) {
      let openTrades: any[] = [];
      try {
        openTrades = await runQuery(`
        SELECT * FROM shadow_trades
        WHERE risk_mode = ? AND status = 'open'${scope ? ' AND (exchange_name IS NULL OR (exchange_name = ? AND account_id = ?))' : ''}
      `, scope ? [mode, scope.exchange, scope.accountId] : [mode], 'all');
      } catch (error) {
        logger.error('Failed to load persisted open trades; refusing to discard state', { service: 'ShadowTrader', mode, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      
      const previousTrades = new Map(this.portfolios[mode].openTrades.map((trade: any) => [String(trade.id), trade]));
      this.portfolios[mode].openTrades = openTrades.map((t: any) => {
        const previous: any = previousTrades.get(String(t.id)) || {};
        const exchangeOrderId = liveOrderIds.get(String(t.id)) || t.exchange_order_id || null;
        const live = Boolean(exchangeOrderId && t.exchange_name && t.account_id);
        const persistedStop = Number(t.stop_loss ?? 0);
        const inMemoryStop = Number(previous.stopLoss ?? 0);
        const stopLoss = inMemoryStop > 0 && persistedStop > 0
          ? (String(t.side).toLowerCase() === 'buy' ? Math.max(inMemoryStop, persistedStop) : Math.min(inMemoryStop, persistedStop))
          : (inMemoryStop || persistedStop || previous.stopLoss);
        return {
          ...previous, ...t,
          amount: Number(t.remaining_amount ?? t.amount),
          stopLoss,
          takeProfit: previous.takeProfit ?? t.take_profit,
          exchangeOrderId,
          isRunner: Boolean(t.is_runner),
          candlesHeld: Number(t.candles_held ?? 0),
          lastUpdateTime: t.last_update_time ?? undefined,
          totalFeeFrac: t.total_fee_frac ?? previous.totalFeeFrac,
          trailingStop: previous.trailingStop
        };
      });

      let result: any[] = [];
      try {
        result = await runQuery(`
        SELECT SUM(pnl) as totalPnl FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed'
      `, [mode], 'all');
      } catch (error) {
        logger.error('Failed to load persisted trade PnL; refusing to discard state', { service: 'ShadowTrader', mode, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      
      const totalPnl = Number(result[0]?.totalPnl || 0) + openTrades.reduce((sum, trade) => sum + Number(trade.realized_pnl || 0), 0);
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
    candleTime?: number,
    shouldAbort: () => boolean = () => false
  ): Promise<boolean> {
    let activeModeTradeOpened = false;
    const marks = new Map<string, Promise<number>>();
    const resolvePrice = async (symbol: string): Promise<number> => {
      if (symbol === signal.symbol) return currentPrice;
      if (!marks.has(symbol)) marks.set(symbol, Promise.resolve().then(() => exchange?.getCurrentPrice?.(symbol)));
      return marks.get(symbol)!;
    };
    for (const mode of Object.values(RiskMode)) {
      if (shouldAbort()) return activeModeTradeOpened;
      const portfolio = this.portfolios[mode];
      const liveOrderEnabled = mode === activeMode && process.env.LIVE_TRADING_ENABLED === 'true';

      if (liveOrderEnabled && signal.side !== 'buy') {
        logger.error('Spot live trading cannot open short exposure', { service: 'ShadowTrader', symbol: signal.symbol, side: signal.side });
        continue;
      }

      if (!await canOpenNewTrade({
        riskManager: this.riskManager, mode, activeMode, portfolio, resolvePrice, exchange
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

      const entry = await this.persistTradeEntry(trade, {
        liveOrderEnabled, activeMode, balanceManager, exchange, candleTime, tradeCost, shouldAbort,
      });
      if (!entry) continue;
      const { idempotencyKey, clientOrderId } = entry;

      if (liveOrderEnabled && shouldAbort()) {
        await runQuery(`UPDATE shadow_trades SET status = 'cancelled' WHERE id = ?`, [trade.id]);
        await runQuery(`UPDATE execution_intents SET status = 'cancelled', updated_at = ? WHERE idempotency_key = ?`,
          [Date.now(), idempotencyKey]);
        continue;
      }

      if (liveOrderEnabled) {
        try {
          if (shouldAbort()) {
            await runQuery(`UPDATE shadow_trades SET status = 'cancelled' WHERE id = ?`, [trade.id]);
            await runQuery(`UPDATE execution_intents SET status = 'cancelled', updated_at = ? WHERE idempotency_key = ?`,
              [Date.now(), idempotencyKey]);
            continue;
          }
          const order = await exchange.placeOrder(trade.symbol, trade.side, trade.amount, 'market', undefined, clientOrderId);
          trade.exchangeOrderId = order.id;
          await runQuery(`UPDATE execution_intents SET status = 'submitted', exchange_order_id = ?, updated_at = ? WHERE idempotency_key = ?`,
            [order.id, Date.now(), idempotencyKey]);
          // An order acknowledgement is not a fill. The reconciler alone opens
          // the persisted position once authoritative fills have been settled.
          continue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await runQuery(`UPDATE execution_intents SET status = 'uncertain', last_error = ?, updated_at = ? WHERE idempotency_key = ?`,
            [message.slice(0, 1000), Date.now(), idempotencyKey]);
          logger.error('Live order outcome is uncertain; entry remains blocked pending reconciliation', {
            service: 'ShadowTrader', tradeId: trade.id, idempotencyKey, error: message
          });
          continue;
        }
      }

      portfolio.openTrades.push(trade);
      if (mode === activeMode) activeModeTradeOpened = true;

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

  private async persistTradeEntry(trade: any, context: {
    liveOrderEnabled: boolean; activeMode?: string; balanceManager?: any; exchange?: any;
    candleTime?: number; tradeCost: number; shouldAbort: () => boolean;
  }): Promise<{ idempotencyKey: string; clientOrderId: string } | null> {
    const { liveOrderEnabled, activeMode, balanceManager, exchange, candleTime, tradeCost, shouldAbort } = context;
    const mode = trade.risk_mode;
    const intentCandleTime = Number.isFinite(candleTime) ? Number(candleTime) : trade.timestamp;
    const idempotencyKey = `${mode}:${trade.symbol}:${trade.side}:${intentCandleTime}`;
    const accountAdapter = exchange?.accountExecutionAdapter;
    const clientOrderId = randomUUID().replace(/-/g, '');
    if (shouldAbort()) return null;
    const intentResult = await runQuery(`
      INSERT INTO execution_intents
        (idempotency_key, trade_id, symbol, risk_mode, side, candle_time, status, created_at, updated_at, exchange_name, account_id, client_order_id, intent_type, requested_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entry', ?)
      ON CONFLICT DO NOTHING
    `, [idempotencyKey, trade.id, trade.symbol, mode, trade.side, intentCandleTime,
      liveOrderEnabled ? 'pending' : 'simulated', trade.timestamp, trade.timestamp, liveOrderEnabled ? accountAdapter?.exchange || exchange?.exchangeName || null : null,
      liveOrderEnabled ? accountAdapter?.accountId || null : null, liveOrderEnabled ? clientOrderId : null, trade.amount], 'run');
    if (intentResult?.changes === 0 || intentResult?.rowCount === 0) return null;

    // Paper ownership and its cash reservation are committed together. Live
    // positions are reserved only when authoritative exchange fills arrive.
    const walletOwned = !liveOrderEnabled && mode === activeMode && Boolean(balanceManager);
    const persistEntry = async (query: typeof runQuery) => {
      await query(`
        INSERT INTO shadow_trades (id, symbol, side, amount, price, status, timestamp, risk_mode, leverage, stop_loss, take_profit, entry_slippage_frac, total_fee_frac, exchange_name, account_id, remaining_amount, wallet_owned, reserved_margin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [trade.id, trade.symbol, trade.side, trade.amount, trade.price, trade.status, trade.timestamp, trade.risk_mode, trade.leverage, trade.stopLoss, trade.takeProfit, trade.entrySlippageFrac, trade.totalFeeFrac,
        liveOrderEnabled ? accountAdapter?.exchange || exchange?.exchangeName || null : null, liveOrderEnabled ? accountAdapter?.accountId || null : null, liveOrderEnabled ? 0 : trade.amount,
        walletOwned ? 1 : 0, walletOwned ? tradeCost : 0]);
      if (walletOwned) await balanceManager.addActiveTradeInTransaction(query, tradeCost, { tradeId: trade.id });
    };
    if (liveOrderEnabled) await persistEntry(runQuery);
    else await withDatabaseTransaction(async query => {
      if (shouldAbort()) throw new Error('Paper entry cancelled before reservation');
      await persistEntry(query);
      await query(`UPDATE execution_intents SET status = 'complete', updated_at = ? WHERE idempotency_key = ?`,
        [Date.now(), idempotencyKey]);
    });
    return { idempotencyKey, clientOrderId };
  }

  private async settlePaperTrade(
    trade: any, ctx: ExitContext, quantity: number, pnl: number,
    options: { stopLoss: number; isRunner: boolean; closeReason?: string },
  ): Promise<void> {
    const now = Date.now();
    const state = await withDatabaseTransaction(async query => {
      const rows = await query(`SELECT * FROM shadow_trades WHERE id = ?`, [trade.id], 'all');
      const persisted = rows[0];
      if (!persisted || persisted.status !== 'open' || persisted.exchange_name) {
        throw new Error('Paper position is not open for settlement');
      }
      const remaining = Number(persisted.remaining_amount ?? persisted.amount);
      const tolerance = Math.max(1e-12, remaining * 1e-10);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remaining + tolerance ||
          Math.abs(remaining - trade.amount) > tolerance) {
        throw new Error('Paper position quantity changed; reload before settlement');
      }
      if (persisted.wallet_owned !== 0 && persisted.wallet_owned !== 1) {
        throw new Error('Legacy paper reservation ownership is unavailable; reconcile before settlement');
      }
      const closed = Boolean(options.closeReason);
      const reserved = Number(persisted.reserved_margin);
      if (!Number.isFinite(reserved) || reserved < 0 || (!persisted.wallet_owned && reserved !== 0)) {
        throw new Error('Paper reservation principal is invalid');
      }
      const principal = closed ? reserved : reserved * quantity / remaining;
      const remainingAmount = closed ? 0 : remaining - quantity;
      const realizedPnl = Number(persisted.realized_pnl || 0) + pnl;
      const reservedMargin = closed ? 0 : reserved - principal;
      const updated = await query(`UPDATE shadow_trades SET
        remaining_amount = ?, realized_pnl = ?, reserved_margin = ?, stop_loss = ?,
        is_runner = ?, candles_held = ?, last_update_time = ?, status = ?,
        pnl = ?, exit_price = ?, exit_timestamp = ?, close_reason = ?
        WHERE id = ? AND status = 'open' AND COALESCE(remaining_amount, amount) = ?`,
      [remainingAmount, realizedPnl, reservedMargin, options.stopLoss, options.isRunner ? 1 : 0,
        trade.candlesHeld || 0, trade.lastUpdateTime ?? null, closed ? 'closed' : 'open',
        closed ? realizedPnl : null, closed ? ctx.currentPrice : null, closed ? now : null,
        options.closeReason ?? null, trade.id, remaining]);
      if (updated?.changes === 0 || updated?.rowCount === 0) throw new Error('Paper settlement lost its position claim');
      if (persisted.wallet_owned) {
        if (!ctx.balanceManager) throw new Error('Wallet-owned paper position requires its balance manager');
        await ctx.balanceManager.recordTradeResultInTransaction(query, pnl, principal, { tradeId: trade.id });
      }
      await query(`INSERT INTO shadow_settlements (id, trade_id, risk_mode, quantity, pnl, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [randomUUID(), trade.id, ctx.mode, quantity, pnl, now]);
      return { remainingAmount, realizedPnl, reservedMargin, walletOwned: persisted.wallet_owned };
    });
    trade.amount = state.remainingAmount;
    trade.remaining_amount = state.remainingAmount;
    trade.realized_pnl = state.realizedPnl;
    trade.reserved_margin = state.reservedMargin;
    trade.wallet_owned = state.walletOwned;
    trade.stopLoss = options.stopLoss;
    trade.isRunner = options.isRunner;
    ctx.portfolio.balance += pnl;
  }

  private async evaluateRatchet(trade: any, ctx: ExitContext): Promise<RatchetUpdate> {
    let trailingStopApplied = false;
    let runnerTriggered = false;
    let stopLoss = trade.stopLoss;

    if (trade.side === 'buy') {
      if (ctx.config.multiCandleHoldEnabled && ctx.profitPct > 0.005) {
        const trailStop = ctx.currentPrice * 0.996;
        if (trailStop > trade.stopLoss) {
          stopLoss = trailStop;
          trailingStopApplied = true;
        }
      }

      if (!trade.exchangeOrderId && ctx.config.runnerEnabled && !trade.isRunner && ctx.profitPct >= (ctx.config.runnerConditions?.triggerProfit / 100 || 0.015)) {
        console.log(`[ShadowTrader] [${ctx.mode}] Runner triggered for ${trade.id}`);
        const exitFactor = ctx.config.runnerConditions?.partialExit || 0.6;
        const closeAmount = trade.amount * exitFactor;
        if (!(exitFactor > 0 && exitFactor < 1)) throw new Error('Runner partial exit fraction must be between zero and one');
        const partialPnl = calculateTradePnl({ ...trade, amount: closeAmount }, ctx.currentPrice);
        stopLoss = Math.max(stopLoss, trade.price * 1.005);
        await this.settlePaperTrade(trade, ctx, closeAmount, partialPnl, { stopLoss, isRunner: true });

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
          stopLoss = trailStop;
          trailingStopApplied = true;
        }
      }
    }

    if (trailingStopApplied && !runnerTriggered) {
      await runQuery(`UPDATE shadow_trades SET stop_loss = ? WHERE id = ? AND status = 'open'`, [stopLoss, trade.id]);
      trade.stopLoss = stopLoss;
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
    const tradeId = String(trade.id);
    if (this.closingTradeIds.has(tradeId)) return false;
    this.closingTradeIds.add(tradeId);
    try {
      return await this.performTradeClosure(trade, exitDecision, pnlRef, ctx, exchange);
    } finally {
      this.closingTradeIds.delete(tradeId);
    }
  }

  private async performTradeClosure(
    trade: any,
    exitDecision: ExitDecision,
    pnlRef: { value: number },
    ctx: ExitContext,
    exchange?: any
  ): Promise<boolean> {
    const closeIntentKey = `close:${trade.id}`;
    let liveCloseIntentClaimed = false;
    if (trade.exchangeOrderId) {
      if (process.env.LIVE_TRADING_ENABLED !== 'true') {
        logger.error('Live close blocked because live trading is disabled', { service: 'ShadowTrader', tradeId: trade.id });
        return false;
      }
      const accountAdapter = exchange?.accountExecutionAdapter;
      if (!accountAdapter?.capabilities?.supportsLiveTrading || accountAdapter.exchange !== trade.exchange_name || accountAdapter.accountId !== trade.account_id) {
        logger.error('Live close blocked: trade and configured exchange account do not match', { service: 'ShadowTrader', tradeId: trade.id });
        return false;
      }
      if (!(exchange?.hasExecutionCredentials ?? Boolean(exchange?.apiKey && exchange?.apiSecret))) {
        logger.error('Live close blocked: exchange credentials are incomplete', { service: 'ShadowTrader', tradeId: trade.id });
        return false;
      }
      try {
        const now = Date.now();
        const clientOrderId = randomUUID().replace(/-/g, '');
        const exitQuantity = Number(trade.remainingAmount ?? trade.remaining_amount ?? trade.amount);
        // Keep close intents distinct from entry intents: reconciliation joins
        // entry order IDs by trade_id, so reusing trade.id here would duplicate
        // local position quantities and replace the entry order ID on reload.
        const claim = await runQuery(`
          INSERT INTO execution_intents
            (idempotency_key, trade_id, symbol, risk_mode, side, candle_time, status, created_at, updated_at, exchange_name, account_id, client_order_id, intent_type, parent_trade_id, requested_quantity)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'exit', ?, ?)
          ON CONFLICT DO NOTHING
        `, [closeIntentKey, `${trade.id}:close`, trade.symbol, ctx.mode, trade.side === 'buy' ? 'sell' : 'buy', now, now, now, accountAdapter?.exchange || exchange?.exchangeName || trade.exchange_name || null, accountAdapter?.accountId || trade.account_id || null, clientOrderId, trade.id, exitQuantity], 'run');
        if (claim?.changes === 0 || claim?.rowCount === 0) {
          logger.error('Live close blocked by an existing close intent; reconciliation required', { service: 'ShadowTrader', tradeId: trade.id });
          return false;
        }
        liveCloseIntentClaimed = true;
        const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
        const order = await exchange.placeOrder(trade.symbol, closeSide, exitQuantity, 'market', undefined, clientOrderId);
        await runQuery(`UPDATE execution_intents SET status = 'submitted', exchange_order_id = ?, updated_at = ? WHERE idempotency_key = ?`,
          [order?.id || null, Date.now(), closeIntentKey]);
        trade.exchangeCloseOrderId = order.id;
        // Keep the position active until authoritative exit fills settle.
        return false;
      } catch (error) {
        if (liveCloseIntentClaimed) {
          await runQuery(`UPDATE execution_intents SET status = 'uncertain', last_error = ?, updated_at = ? WHERE idempotency_key = ?`,
            [(error instanceof Error ? error.message : String(error)).slice(0, 1000), Date.now(), closeIntentKey]);
        }
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
    const closedQuantity = trade.amount;
    await this.settlePaperTrade(trade, ctx, closedQuantity, pnl, {
      stopLoss: trade.stopLoss, isRunner: Boolean(trade.isRunner), closeReason: exitDecision.reason,
    });

    if (pnl > 0) {
      this.riskManager.recordWin(ctx.mode);
    } else {
      this.riskManager.recordLoss(ctx.mode);
    }

    if (liveCloseIntentClaimed) {
      await runQuery(`UPDATE execution_intents SET status = 'complete', updated_at = ? WHERE idempotency_key = ?`,
        [Date.now(), closeIntentKey]);
    }

    await this.logAuditTrade(
      trade.id,
      'close',
      ctx.mode,
      trade.leverage,
      trade.symbol,
      trade.side,
      closedQuantity,
      ctx.currentPrice,
      exitDecision.reason,
      pnl,
      { candlesHeld: trade.candlesHeld, profitPct: ctx.profitPct, liquidationThreshold: ctx.leverage ? 1 / ctx.leverage - ctx.maintenanceMargin : null }
    );

    console.log(`Shadow Trader [${ctx.mode}]: Trade ${trade.id} closed due to ${exitDecision.reason}. PnL: ${pnl.toFixed(2)}`);
    return true;
  }

  async updatePositions(currentPrice: number, activeMode?: string, balanceManager?: any, exchange?: any, lastCandle: any = null, currentSymbol?: string, timeframe = '1m') {
    // Reconciliation may have settled a fill since the last trading cycle.
    const account = exchange?.accountExecutionAdapter;
    if (account) await this.loadState({ exchange: account.exchange, accountId: account.accountId });
    const candlesBySymbol = new Map<string, any>();
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      const newOpenTrades = [];
      const config = this.riskManager.getConfig(mode as RiskMode);
      const maintenanceMargin = 0.005;

      for (const trade of portfolio.openTrades) {
        let tradePrice = currentPrice;
        let tradeCandle = lastCandle;
        if (currentSymbol && trade.symbol !== currentSymbol) {
          if (!candlesBySymbol.has(trade.symbol)) {
            try {
              const candles = await exchange?.getCandles?.(trade.symbol, timeframe, 1);
              candlesBySymbol.set(trade.symbol, Array.isArray(candles) ? candles[candles.length - 1] : null);
            } catch (error) {
              logger.warn('Position update skipped: could not fetch price for its own symbol', {
                service: 'ShadowTrader', tradeId: trade.id, symbol: trade.symbol,
                error: error instanceof Error ? error.message : String(error)
              });
              candlesBySymbol.set(trade.symbol, null);
            }
          }
          tradeCandle = candlesBySymbol.get(trade.symbol);
          if (!Number.isFinite(Number(tradeCandle?.close)) || Number(tradeCandle.close) <= 0) {
            newOpenTrades.push(trade);
            continue;
          }
          tradePrice = Number(tradeCandle.close);
        }
        if (tradeCandle && (!trade.lastUpdateTime || tradeCandle.time > trade.lastUpdateTime)) {
          trade.candlesHeld = (trade.candlesHeld || 0) + 1;
          trade.lastUpdateTime = tradeCandle.time;
        }

        console.log(`[ShadowTrader] Checking trade ${trade.id} for ${mode}. Price: ${tradePrice}, SL: ${trade.stopLoss}, TP: ${trade.takeProfit}`);
        const leverage = trade.leverage || config.leverage || 1;
        const marginUsed = trade.amount * trade.price / leverage;
        const currentNotional = trade.amount * tradePrice;
        const currentMargin = currentNotional / leverage;
        const profitPct = trade.side === 'buy'
          ? (tradePrice - trade.price) / trade.price
          : (trade.price - tradePrice) / trade.price;

        const ctx: ExitContext = {
          currentPrice: tradePrice, config, mode: mode as RiskMode, leverage, marginUsed, currentMargin,
          profitPct, maintenanceMargin, activeMode, balanceManager, portfolio
        };

        // 1. Ratchet: trailing stop + runner (mutates trade, side effects)
        await this.evaluateRatchet(trade, ctx);
        // A partial exit changes both the remaining economics and its margin.
        const pnl = calculateTradePnl(trade, tradePrice);
        ctx.marginUsed = trade.amount * trade.price / leverage;
        ctx.currentMargin = trade.amount * tradePrice / leverage;
        await runQuery(`UPDATE shadow_trades SET candles_held = ?, last_update_time = ?
          WHERE id = ? AND status = 'open'`, [trade.candlesHeld || 0, trade.lastUpdateTime ?? null, trade.id]);

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
         const pnl = calculateTradePnl(trade, currentPrice);
         const leverage = trade.leverage || 1;
         const ctx: ExitContext = {
           currentPrice, config: this.riskManager.getConfig(mode), mode,
           leverage, marginUsed: trade.amount * trade.price / leverage,
           currentMargin: trade.amount * currentPrice / leverage,
           profitPct: trade.price ? Math.abs(currentPrice - trade.price) / trade.price : 0,
           maintenanceMargin: 0.005, activeMode, balanceManager, portfolio
         };
         const closed = await this.executeTradeClosure(
           trade, { exitPrice: currentPrice, reason: 'manual_close' }, { value: pnl }, ctx, exchange
         );
         if (closed) portfolio.openTrades.splice(tradeIndex, 1);
         return closed;
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
      const totalPnl = Number(stat.totalPnl || 0) + portfolio.openTrades.reduce((sum, trade) => sum + Number(trade.realized_pnl || 0), 0);
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
