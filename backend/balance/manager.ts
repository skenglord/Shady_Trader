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

  private async applyAtomicMutation(
    sql: string,
    params: any[],
    eventType: string,
    changeAmount: number,
    reason: string,
    metadata?: any,
    failureMessage = 'Balance operation could not be applied'
  ): Promise<void> {
    const before = await this.getBalances();
    const result = await runQuery(sql, params);
    if (result?.changes === 0 || result?.rowCount === 0) throw new Error(failureMessage);
    const after = await this.getBalances();
    await this.logAuditBalance(eventType, before, after, changeAmount, reason, metadata);
  }

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
    await runQuery(`
      INSERT OR IGNORE INTO balances
        (id, main_balance, bot_balance, active_trade_balance, total_pnl, total_pnl_pct)
      VALUES ('default', 100000, 0, 0, 0, 0)
    `);
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
    this.validateAmount(amount);
    await this.applyAtomicMutation(`
      UPDATE balances
      SET main_balance = main_balance - ?, bot_balance = bot_balance + ?
      WHERE id = 'default' AND main_balance >= ?
    `, [amount, amount, amount], 'allocation', amount, 'allocate_to_bot', undefined, 'Insufficient main balance');
  }

  async withdrawFromBot(amount: number) {
    this.validateAmount(amount);
    await this.applyAtomicMutation(`
      UPDATE balances
      SET main_balance = main_balance + ?, bot_balance = bot_balance - ?
      WHERE id = 'default' AND bot_balance >= ?
    `, [amount, amount, amount], 'withdrawal', amount, 'withdraw_from_bot', undefined, 'Insufficient bot balance');
  }

  async halfBotBalance() {
    const current = await this.getBalances();
    const amount = current.botBalance / 2;
    await this.applyAtomicMutation(`
      UPDATE balances
      SET main_balance = main_balance + (bot_balance / 2), bot_balance = bot_balance - (bot_balance / 2)
      WHERE id = 'default'
    `, [], 'withdrawal', amount, 'half_bot_balance');
  }

  async doubleBotBalance() {
    const current = await this.getBalances();
    this.validateAmount(current.botBalance);
    await this.applyAtomicMutation(`
      UPDATE balances
      SET main_balance = main_balance - bot_balance, bot_balance = bot_balance + bot_balance
      WHERE id = 'default' AND main_balance >= bot_balance
    `, [], 'allocation', current.botBalance, 'double_bot_balance', undefined, 'Insufficient main balance');
  }

  async updateActiveTradeBalance(amount: number) {
    if (!Number.isFinite(amount)) throw new Error('Invalid active trade balance adjustment');
    await this.applyAtomicMutation(`
      UPDATE balances SET active_trade_balance = active_trade_balance + ?
      WHERE id = 'default' AND active_trade_balance + ? >= 0
    `, [amount, amount], 'active_trade_adjustment', amount, 'update_active_trade_balance', undefined, 'Insufficient active trade balance');
  }

  async recordTradeResult(pnl: number, tradeValue: number) {
    if (!Number.isFinite(pnl)) throw new Error('Invalid trade PnL');
    this.validateAmount(tradeValue);
    await this.applyAtomicMutation(`
      UPDATE balances SET
        bot_balance = bot_balance + ?,
        active_trade_balance = CASE WHEN active_trade_balance >= ? THEN active_trade_balance - ? ELSE 0 END,
        total_pnl = total_pnl + ?,
        total_pnl_pct = CASE WHEN main_balance + bot_balance > 0
          THEN ((total_pnl + ?) / (main_balance + bot_balance)) * 100 ELSE 0 END
      WHERE id = 'default'
    `, [tradeValue + pnl, tradeValue, tradeValue, pnl, pnl], 'pnl_adjustment', pnl, 'trade_result', { tradeValue });
  }

  async addActiveTrade(tradeValue: number) {
    this.validateAmount(tradeValue);
    await this.applyAtomicMutation(`
      UPDATE balances
      SET bot_balance = bot_balance - ?, active_trade_balance = active_trade_balance + ?
      WHERE id = 'default' AND bot_balance >= ?
    `, [tradeValue, tradeValue, tradeValue], 'active_trade_addition', tradeValue, 'add_active_trade', undefined, 'Insufficient bot balance');
  }

  private validateAmount(amount: number) {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Amount must be a finite non-negative number');
  }
}
