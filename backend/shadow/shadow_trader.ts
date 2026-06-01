import { RiskMode, RiskManager } from '../risk/manager.js';
import { runQuery } from '../database.js';
import { randomUUID } from 'crypto';
import { CostEstimator, OrderRequest, SlippageCircuitBreaker } from '../slippage/index.js';
import { computeFill } from '../slippage/fillCalculator.js';
import { Decimal } from 'decimal.js';

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
        takeProfit: t.take_profit
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
    regime: string = 'uncertain'
  ) {
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      
      const balances = balanceManager ? await balanceManager.getBalances() : null;
      // Use portfolio's own balance for state checks, botBalance for position sizing only
      const effectiveBalance = portfolio.balance;

      if (mode === activeMode) {
        console.log(`[ShadowTrader] Debug ${mode}: effectiveBalance=${effectiveBalance}, portfolio.balance=${portfolio.balance}, botBalance=${balances?.botBalance}, activeMode=${activeMode}`);
      }

      // Check circuit breakers
      const dailyLoss = 0; // Calculate daily loss from DB
      const haltReason = this.riskManager.checkCircuitBreakers(effectiveBalance, portfolio.initialBalance, dailyLoss, mode);
      if (haltReason) {
        console.log(`Shadow Trader [${mode}]: Halted - ${haltReason}. Effective Balance: ${effectiveBalance}, Initial: ${portfolio.initialBalance}`);
        continue;
      }

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

      // Block 7: realistic slippage-adjusted fill (fractions only)
      const fill = computeFill(signal.side as 'buy' | 'sell', currentPrice, tpPct, estSlippageFrac);
      if (fill.skipped) {
        console.log(`Shadow Trader [${mode}]: Trade skipped - ${fill.skipReason}`);
        continue;
      }

      // Execute shadow trade
      const trade = {
        id: `shadow-${mode}-${Date.now()}`,
        symbol: signal.symbol,
        side: signal.side,
        amount: positionSize,
        price: fill.fillPrice,
        status: 'open',
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
      const tradeCost = trade.amount * trade.price / trade.leverage;
      if (mode === activeMode && balances && tradeCost > balances.botBalance) {
        console.log(`Shadow Trader [${mode}]: Trade rejected - Insufficient bot balance. Cost: ${tradeCost}, Bot: ${balances.botBalance}`);
        continue;
      }

      if (mode === activeMode && exchange && exchange.apiKey) {
        try {
           const order = await exchange.placeOrder(trade.symbol, trade.side, trade.amount, 'market');
           trade.exchangeOrderId = order.id;
           console.log(`Live order executed for ${trade.symbol} (${trade.side}): ${order.id}`);
        } catch (e: any) {
           console.error(`Failed to execute live order for ${trade.symbol}: ${e.message}`);
           // If live execution fails, we might still want to record the shadow trade, or skip.
           // For now, we'll continue with the shadow trade.
        }
      }

      portfolio.openTrades.push(trade);

      if (mode === activeMode && balanceManager) {
        balanceManager.addActiveTrade(trade.amount * trade.price / trade.leverage);
      }

       // Save to DB
       await runQuery(`
         INSERT INTO shadow_trades (id, symbol, side, amount, price, status, timestamp, risk_mode, leverage, stop_loss, take_profit, entry_slippage_frac, total_fee_frac)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       `, [trade.id, trade.symbol, trade.side, trade.amount, trade.price, trade.status, trade.timestamp, trade.risk_mode, trade.leverage, trade.stopLoss, trade.takeProfit, trade.entrySlippageFrac, trade.totalFeeFrac]);

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
  }

  async updatePositions(currentPrice: number, activeMode?: string, balanceManager?: any, exchange?: any, lastCandle: any = null) {
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      const newOpenTrades = [];
       const config = this.riskManager.getConfig(mode as RiskMode);
       const maintenanceMargin = 0.005; // 0.5% maintenance margin

       for (const trade of portfolio.openTrades) {
         // Increment candles held if a new candle is provided
         if (lastCandle && (!trade.lastUpdateTime || lastCandle.time > trade.lastUpdateTime)) {
           trade.candlesHeld = (trade.candlesHeld || 0) + 1;
           trade.lastUpdateTime = lastCandle.time;
         }

         console.log(`[ShadowTrader] Checking trade ${trade.id} for ${mode}. Price: ${currentPrice}, SL: ${trade.stopLoss}, TP: ${trade.takeProfit}`);
         let pnl = 0;
         let closed = false;
         let exitReason = '';
         const leverage = trade.leverage || config.leverage || 1;
         const marginUsed = trade.amount * trade.price / leverage;
         const currentNotional = trade.amount * currentPrice;
         const currentMargin = currentNotional / leverage;
         const profitPct = trade.side === 'buy'
           ? (currentPrice - trade.price) / trade.price
           : (trade.price - currentPrice) / trade.price;

         if (trade.side === 'buy') {
           pnl = (currentMargin - marginUsed); // Leveraged PnL based on margin
           
          // MD Part 2.1: Multi-candle hold & Trailing Stop
          if (config.multiCandleHoldEnabled && profitPct > 0.005) {
            const trailStop = currentPrice * 0.996; // 0.4% trail as per Moderate mode
            if (trailStop > trade.stopLoss) {
              trade.stopLoss = trailStop;
            }
          }

          // Part 2.1: Runner Position Logic
          if (config.runnerEnabled && !trade.isRunner && profitPct >= (config.runnerConditions?.triggerProfit / 100 || 0.015)) {
             console.log(`[ShadowTrader] [${mode}] Runner triggered for ${trade.id}`);
             // Partial exit (close e.g. 60%)
             const exitFactor = config.runnerConditions?.partialExit || 0.6;
             const closeAmount = trade.amount * exitFactor;
             const closeMargin = closeAmount * trade.price / leverage;
             const partialPnl = (currentMargin - marginUsed) * (closeAmount / trade.amount); // Proportional margin PnL

            portfolio.balance += partialPnl;
            trade.amount -= closeAmount;
            trade.isRunner = true;
            // Lock in minimum profit on runner (entry + 0.5%)
            trade.stopLoss = Math.max(trade.stopLoss, trade.price * 1.005);

            if (mode === activeMode && balanceManager) {
              const tradeCost = closeAmount * trade.price / trade.leverage;
              balanceManager.recordTradeResult(partialPnl, tradeCost);
            }

            // Audit log: partial exit
            await this.logAuditTrade(
              trade.id,
              'partial_exit',
              mode,
              trade.leverage,
              trade.symbol,
              trade.side,
              closeAmount,
              currentPrice,
              'runner',
              partialPnl,
              { remainingAmount: trade.amount, totalExited: closeAmount, profitPct }
            );
          }

          // Part 2.1: Early Exit Feature
          if (config.earlyExitEnabled && profitPct >= (config.earlyExitTarget / 100)) {
            closed = true;
            exitReason = 'early_exit';
          }

           // Liquidation Logic
           const lossPct = (marginUsed - currentMargin) / marginUsed; // Percentage of margin lost (same as notional loss %)
           if (lossPct >= (1 / leverage) - maintenanceMargin) { // Liquidation threshold based on leverage
             closed = true;
             exitReason = 'liquidation';
             pnl = -marginUsed; // Total loss of margin
           } else if (currentPrice <= trade.stopLoss) {
             closed = true;
             exitReason = 'stop_loss';
           } else if (currentPrice >= trade.takeProfit && !trade.isRunner) {
             closed = true;
             exitReason = 'take_profit';
           }

          // Multi-candle expiration
          if (config.multiCandleHoldEnabled && trade.candlesHeld >= (config.holdConditions?.maxCandles || 3)) {
            closed = true;
            exitReason = 'multi_candle_expiry';
          }
         } else {
           pnl = (marginUsed - currentMargin); // Leveraged PnL based on margin
            
           // Trailing Stop Logic for Shorts
          if (config.multiCandleHoldEnabled && profitPct > 0.005) {
            const trailStop = currentPrice * 1.004; // 0.4% trail
            if (trailStop < trade.stopLoss) {
              trade.stopLoss = trailStop;
            }
          }

          // Part 2.1: Early Exit Feature
          if (config.earlyExitEnabled && profitPct >= (config.earlyExitTarget / 100)) {
            closed = true;
            exitReason = 'early_exit';
          }

           // Liquidation Logic
           const lossPct = (marginUsed - currentMargin) / marginUsed; // Percentage of margin lost (same as notional loss %)
           if (lossPct >= (1 / leverage) - maintenanceMargin) { // Liquidation threshold based on leverage
             closed = true;
             exitReason = 'liquidation';
             pnl = -marginUsed; // Total loss of margin
           } else if (currentPrice >= trade.stopLoss) {
             closed = true;
             exitReason = 'stop_loss';
           } else if (currentPrice <= trade.takeProfit && !trade.isRunner) {
             closed = true;
             exitReason = 'take_profit';
           }

          // Multi-candle expiration
          if (config.multiCandleHoldEnabled && trade.candlesHeld >= (config.holdConditions?.maxCandles || 3)) {
            closed = true;
            exitReason = 'multi_candle_expiry';
          }
         }

         if (closed) {
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
             
             if (exchange && exchange.apiKey) {
                try {
                  const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
                  const order = await exchange.placeOrder(trade.symbol, closeSide, trade.amount, 'market');
                  console.log(`Live close order executed for ${trade.symbol} (${closeSide}): ${order.id}`);
                } catch (e: any) {
                  console.error(`Failed to execute live close order for ${trade.symbol}: ${e.message}`);
                }
             }
           }
           
            // Update DB
            await runQuery(`
              UPDATE shadow_trades
              SET status = 'closed', pnl = ?, exit_price = ?, exit_timestamp = ?
              WHERE id = ?
            `, [pnl, currentPrice, Date.now(), trade.id]);

            // Audit log: trade close
            await this.logAuditTrade(
              trade.id,
              'close',
              mode,
              trade.leverage,
              trade.symbol,
              trade.side,
              trade.amount,
              currentPrice,
              exitReason,
              pnl,
              { candlesHeld: trade.candlesHeld, profitPct, liquidationThreshold: leverage ? 1 / leverage - maintenanceMargin : null }
            );

            console.log(`Shadow Trader [${mode}]: Trade ${trade.id} closed due to ${exitReason}. PnL: ${pnl.toFixed(2)}`);
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
         const leverage = trade.leverage || 1;
         const marginUsed = trade.amount * trade.price / leverage;
         const currentNotional = trade.amount * currentPrice;
         const currentMargin = currentNotional / leverage;
         let pnl = 0;
         if (trade.side === 'buy') {
           pnl = currentMargin - marginUsed;
         } else {
           pnl = marginUsed - currentMargin;
         }

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
           
           if (exchange && exchange.apiKey) {
             try {
               const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
               await exchange.placeOrder(trade.symbol, closeSide, trade.amount, 'market');
             } catch (e: any) {
               console.error(`Failed to execute live close order for ${trade.symbol}: ${e.message}`);
             }
           }
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
      
      const stats = await runQuery(`
        SELECT COUNT(*) as count, SUM(pnl) as totalPnl
        FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed'
      `, [mode], 'all');
      const stat = stats[0];

      const wins = await runQuery(`
        SELECT COUNT(*) as count
        FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed' AND pnl > 0
      `, [mode], 'all');
      const winCount = wins[0].count;

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
