import { RiskMode, RiskManager } from '../risk/manager.js';
import { runQuery } from '../database.js';

export class ShadowTrader {
  portfolios: Record<RiskMode, { balance: number, initialBalance: number, openTrades: any[] }>;
  riskManager: RiskManager;

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

  async init() {
    await this.loadState();
  }

  async reset() {
    await runQuery(`DELETE FROM shadow_trades`);
    for (const mode of Object.values(RiskMode)) {
      this.portfolios[mode as RiskMode] = { balance: 100000, initialBalance: 100000, openTrades: [] };
      console.log(`[ShadowTrader] Resetting ${mode} to 100000`);
    }
  }

  async loadState() {
    for (const mode of Object.values(RiskMode)) {
      const openTrades = await runQuery(`
        SELECT * FROM shadow_trades
        WHERE risk_mode = ? AND status = 'open'
      `, [mode], 'all');
      
      this.portfolios[mode].openTrades = openTrades.map((t: any) => ({
        ...t,
        stopLoss: t.stop_loss,
        takeProfit: t.take_profit
      }));

      const result = await runQuery(`
        SELECT SUM(pnl) as totalPnl FROM shadow_trades
        WHERE risk_mode = ? AND status = 'closed'
      `, [mode], 'all');
      
      const totalPnl = result[0]?.totalPnl || 0;
      this.portfolios[mode].balance = this.portfolios[mode].initialBalance + totalPnl;
    }
  }

  async processSignal(signal: any, currentPrice: number, activeMode?: string, balanceManager?: any, exchange?: any) {
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      
      const balances = balanceManager ? await balanceManager.getBalances() : null;
      // Use bot balance for limit check
      const effectiveBalance = (mode === activeMode && balances) ? balances.botBalance : portfolio.balance;

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
      if (!this.riskManager.validateTrade(signal, mode, portfolio.openTrades.length)) {
        continue;
      }

      // Calculate position size
      const positionSize = this.riskManager.calculatePositionSize(effectiveBalance, signal.entryPrice, signal.stopLoss, mode as RiskMode);
      if (positionSize <= 0) continue;

      // Adjust TP/SL based on mode config
      const config = this.riskManager.getConfig(mode as RiskMode);
      const riskPerUnit = Math.abs(signal.entryPrice - signal.stopLoss);
      const adjustedStopLoss = signal.side === 'buy' 
        ? signal.entryPrice - (riskPerUnit * config.slMultiplier)
        : signal.entryPrice + (riskPerUnit * config.slMultiplier);
      const adjustedTakeProfit = signal.side === 'buy'
        ? signal.entryPrice + (riskPerUnit * config.tpMultiplier)
        : signal.entryPrice - (riskPerUnit * config.tpMultiplier);

      // Execute shadow trade
      const trade = {
        id: `shadow-${mode}-${Date.now()}`,
        symbol: signal.symbol,
        side: signal.side,
        amount: positionSize,
        price: currentPrice,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: mode,
        stopLoss: adjustedStopLoss,
        takeProfit: adjustedTakeProfit,
        leverage: config.leverage || 1,
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
        INSERT INTO shadow_trades (id, symbol, side, amount, price, status, timestamp, risk_mode, leverage, stop_loss, take_profit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [trade.id, trade.symbol, trade.side, trade.amount, trade.price, trade.status, trade.timestamp, trade.risk_mode, trade.leverage, trade.stopLoss, trade.takeProfit]);
    }
  }

  async updatePositions(currentPrice: number, activeMode?: string, balanceManager?: any, exchange?: any) {
    for (const mode of Object.values(RiskMode)) {
      const portfolio = this.portfolios[mode];
      const newOpenTrades = [];
      const config = this.riskManager.getConfig(mode as RiskMode);
      const leverage = config.leverage || 1;
      const maintenanceMargin = 0.005; // 0.5% maintenance margin

      for (const trade of portfolio.openTrades) {
        console.log(`[ShadowTrader] Checking trade ${trade.id} for ${mode}. Price: ${currentPrice}, SL: ${trade.stopLoss}, TP: ${trade.takeProfit}`);
        let pnl = 0;
        let closed = false;
        let exitReason = '';

        if (trade.side === 'buy') {
          pnl = (currentPrice - trade.price) * trade.amount;
          
          // Trailing Stop Logic: if price moves up, trail the stop loss behind it
          // Let's trail by the original risk amount (entry - initial stop loss)
          // Since we don't store initial stop loss, we can trail by a fixed percentage (e.g., 2%)
          // Or we can just calculate the current profit % and trail if it's > 1%
          const profitPct = (currentPrice - trade.price) / trade.price;
          if (profitPct > 0.01) {
            const trailStop = currentPrice * 0.99; // 1% trailing stop
            if (trailStop > trade.stopLoss) {
              trade.stopLoss = trailStop;
            }
          }

          // Liquidation Logic
          const lossPct = (trade.price - currentPrice) / trade.price;
          if (lossPct >= (1 / leverage) - maintenanceMargin) {
            closed = true;
            exitReason = 'liquidation';
            pnl = -trade.amount * trade.price * (1 / leverage); // Total loss of margin
          } else if (currentPrice <= trade.stopLoss) {
            closed = true;
            exitReason = 'stop_loss';
          } else if (currentPrice >= trade.takeProfit) {
            closed = true;
            exitReason = 'take_profit';
          }
        } else {
          pnl = (trade.price - currentPrice) * trade.amount;
          
          // Trailing Stop Logic
          const profitPct = (trade.price - currentPrice) / trade.price;
          if (profitPct > 0.01) {
            const trailStop = currentPrice * 1.01; // 1% trailing stop
            if (trailStop < trade.stopLoss) {
              trade.stopLoss = trailStop;
            }
          }

          // Liquidation Logic
          const lossPct = (currentPrice - trade.price) / trade.price;
          if (lossPct >= (1 / leverage) - maintenanceMargin) {
            closed = true;
            exitReason = 'liquidation';
            pnl = -trade.amount * trade.price * (1 / leverage); // Total loss of margin
          } else if (currentPrice >= trade.stopLoss) {
            closed = true;
            exitReason = 'stop_loss';
          } else if (currentPrice <= trade.takeProfit) {
            closed = true;
            exitReason = 'take_profit';
          }
        }

        if (closed) {
          portfolio.balance += pnl;
          
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
        let pnl = 0;
        if (trade.side === 'buy') {
          pnl = (currentPrice - trade.price) * trade.amount;
        } else {
          pnl = (trade.price - currentPrice) * trade.amount;
        }

        portfolio.balance += pnl;
        
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
