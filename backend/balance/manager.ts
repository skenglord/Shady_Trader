import { runQuery } from '../database.js';
import { randomUUID } from 'crypto';
import { logger } from '../logging/logger.js';

export interface Balances {
  mainBalance: number;
  botBalance: number;
  activeTradeBalance: number;
  totalPnl: number;
  totalPnlPct: number;
}

export class BalanceManager {
  constructor() {}

  private async logAuditBalance(
    eventType: string,
    beforeBalances: Balances,
    afterBalances: Balances,
    changeAmount: number,
    reason: string,
    metadata?: any
  ) {
    try {
      const auditId = randomUUID();
      const timestamp = Date.now();
      const metadataJson = metadata ? JSON.stringify(metadata) : null;

      await runQuery(`
        INSERT INTO audit_balances (
          id, balance_id, event_type, timestamp,
          before_main_balance, before_bot_balance, before_active_balance,
          after_main_balance, after_bot_balance, after_active_balance,
          change_amount, reason, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        auditId, 'default', eventType, timestamp,
        beforeBalances.mainBalance, beforeBalances.botBalance, beforeBalances.activeTradeBalance,
        afterBalances.mainBalance, afterBalances.botBalance, afterBalances.activeTradeBalance,
        changeAmount, reason, metadataJson
      ]);
    } catch (error: any) {
      logger.error('Failed to log audit balance', { error: String(error), service: 'balance-manager' });
      // Don't throw - audit logging shouldn't break balance operations
    }
  }

  async getBalances(): Promise<Balances> {
    const rows = await runQuery('SELECT * FROM balances WHERE id = ?', ['default'], 'all');
    const row = rows[0] || {};
    const b = {
      mainBalance: row.main_balance ?? 100000,
      botBalance: row.bot_balance ?? 0,
      activeTradeBalance: row.active_trade_balance ?? 0,
      totalPnl: row.total_pnl ?? 0,
      totalPnlPct: row.total_pnl_pct ?? 0
    };
    return b;
  }

  async updateBalances(balances: Partial<Balances>) {
    const current = await this.getBalances();
    const updated = { ...current, ...balances };
    
    await runQuery(`
      INSERT OR REPLACE INTO balances (id, main_balance, bot_balance, active_trade_balance, total_pnl, total_pnl_pct)
      VALUES ('default', ?, ?, ?, ?, ?)
    `, [
      updated.mainBalance,
      updated.botBalance,
      updated.activeTradeBalance,
      updated.totalPnl,
      updated.totalPnlPct
    ]);
  }

  async allocateToBot(amount: number) {
    const current = await this.getBalances();
    if (amount > current.mainBalance) throw new Error('Insufficient main balance');

    const updated = {
      mainBalance: current.mainBalance - amount,
      botBalance: current.botBalance + amount,
      activeTradeBalance: current.activeTradeBalance,
      totalPnl: current.totalPnl,
      totalPnlPct: current.totalPnlPct
    };

    await this.updateBalances(updated);

    // Audit log
    await this.logAuditBalance('allocation', current, updated, amount, 'allocate_to_bot');
  }

  async withdrawFromBot(amount: number) {
    const current = await this.getBalances();
    if (amount > current.botBalance) throw new Error('Insufficient bot balance');

    const updated = {
      mainBalance: current.mainBalance + amount,
      botBalance: current.botBalance - amount,
      activeTradeBalance: current.activeTradeBalance,
      totalPnl: current.totalPnl,
      totalPnlPct: current.totalPnlPct
    };

    await this.updateBalances(updated);

    // Audit log
    await this.logAuditBalance('withdrawal', current, updated, amount, 'withdraw_from_bot');
  }

  async halfBotBalance() {
    const current = await this.getBalances();
    const amount = current.botBalance / 2;
    await this.withdrawFromBot(amount);
  }

  async doubleBotBalance() {
    const current = await this.getBalances();
    await this.allocateToBot(current.botBalance);
  }

  async updateActiveTradeBalance(amount: number) {
    const current = await this.getBalances();
    await this.updateBalances({
      activeTradeBalance: current.activeTradeBalance + amount
    });
  }

  async recordTradeResult(pnl: number, tradeValue: number) {
    const current = await this.getBalances();
    // Return the initial trade value to bot balance, plus/minus the pnl
    const newBotBalance = current.botBalance + tradeValue + pnl;
    const newActiveTradeBalance = Math.max(0, current.activeTradeBalance - tradeValue);
    const newTotalPnl = current.totalPnl + pnl;

    // Calculate PnL % based on the total balance
    const totalBalance = current.mainBalance + current.botBalance;
    const newTotalPnlPct = totalBalance > 0 ? (newTotalPnl / totalBalance) * 100 : 0;

    const updated = {
      mainBalance: current.mainBalance,
      botBalance: newBotBalance,
      activeTradeBalance: newActiveTradeBalance,
      totalPnl: newTotalPnl,
      totalPnlPct: newTotalPnlPct
    };

    await this.updateBalances(updated);

    // Audit log
    await this.logAuditBalance('pnl_adjustment', current, updated, pnl, 'trade_result', { tradeValue });
  }

  async addActiveTrade(tradeValue: number) {
    const current = await this.getBalances();
    // Deduct trade value from bot balance and move to active trade balance
    const updated = {
      mainBalance: current.mainBalance,
      botBalance: current.botBalance - tradeValue,
      activeTradeBalance: current.activeTradeBalance + tradeValue,
      totalPnl: current.totalPnl,
      totalPnlPct: current.totalPnlPct
    };

    await this.updateBalances(updated);

    // Audit log
    await this.logAuditBalance('active_trade_addition', current, updated, tradeValue, 'add_active_trade');
  }
}
