import { runQuery, withDatabaseTransaction, type TransactionQuery } from '../database.js';
import { randomUUID } from 'crypto';

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
    changeAmount: number | ((before: Balances, after: Balances) => number),
    reason: string,
    metadata?: any,
    failureMessage = 'Balance operation could not be applied',
    validateBefore?: (before: Balances) => void,
  ): Promise<void> {
    await withDatabaseTransaction(async query => {
      const before = await this.readBalances(query);
      validateBefore?.(before);
      const result = await query(sql, params);
      if (result?.changes === 0 || result?.rowCount === 0) throw new Error(failureMessage);
      const after = await this.readBalances(query);
      const actualChangeAmount = typeof changeAmount === 'function' ? changeAmount(before, after) : changeAmount;
      await this.logAuditBalance(query, eventType, before, after, actualChangeAmount, reason, metadata);
    });
  }

  private async logAuditBalance(
    query: TransactionQuery,
    eventType: string,
    beforeBalances: Balances,
    afterBalances: Balances,
    changeAmount: number,
    reason: string,
    metadata?: any
  ) {
    const auditId = randomUUID();
    const timestamp = Date.now();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    await query(`
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
  }

  async getBalances(): Promise<Balances> {
    return this.readBalances(async (sql, params = [], type = 'run') => runQuery(sql, params, type));
  }

  private async readBalances(query: TransactionQuery): Promise<Balances> {
    await query(`
      INSERT OR IGNORE INTO balances
        (id, main_balance, bot_balance, active_trade_balance, total_pnl, total_pnl_pct)
      VALUES ('default', 100000, 0, 0, 0, 0)
    `);
    const rows = await query('SELECT * FROM balances WHERE id = ?', ['default'], 'all');
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
    await this.applyAtomicMutation(`
      UPDATE balances
      SET main_balance = main_balance + (bot_balance / 2), bot_balance = bot_balance - (bot_balance / 2)
      WHERE id = 'default'
    `, [], 'withdrawal', before => before.botBalance / 2, 'half_bot_balance');
  }

  async doubleBotBalance() {
    await this.applyAtomicMutation(`
      UPDATE balances
      SET main_balance = main_balance - bot_balance, bot_balance = bot_balance + bot_balance
      WHERE id = 'default' AND main_balance >= bot_balance
    `, [], 'allocation', before => before.botBalance, 'double_bot_balance', undefined,
      'Insufficient main balance', before => this.validateAmount(before.botBalance));
  }

  async updateActiveTradeBalance(amount: number) {
    if (!Number.isFinite(amount)) throw new Error('Invalid active trade balance adjustment');
    await this.applyAtomicMutation(`
      UPDATE balances SET active_trade_balance = active_trade_balance + ?
      WHERE id = 'default' AND active_trade_balance + ? >= 0
    `, [amount, amount], 'active_trade_adjustment', amount, 'update_active_trade_balance', undefined, 'Insufficient active trade balance');
  }

  async recordTradeResult(pnl: number, tradeValue: number) {
    await withDatabaseTransaction(query => this.recordTradeResultInTransaction(query, pnl, tradeValue));
  }

  async recordTradeResultInTransaction(query: TransactionQuery, pnl: number, tradeValue: number, metadata?: unknown) {
    if (!Number.isFinite(pnl)) throw new Error('Invalid trade PnL');
    this.validateAmount(tradeValue);
    const before = await this.readBalances(query);
    const result = await query(`
      UPDATE balances SET
        bot_balance = bot_balance + ?,
        active_trade_balance = CASE WHEN active_trade_balance >= ? THEN active_trade_balance - ? ELSE 0 END,
        total_pnl = total_pnl + ?,
        total_pnl_pct = CASE WHEN main_balance + bot_balance > 0
          THEN ((total_pnl + ?) / (main_balance + bot_balance)) * 100 ELSE 0 END
      WHERE id = 'default'
    `, [tradeValue + pnl, tradeValue, tradeValue, pnl, pnl]);
    if (result?.changes === 0 || result?.rowCount === 0) throw new Error('Trade result could not be applied');
    const after = await this.readBalances(query);
    await this.logAuditBalance(query, 'pnl_adjustment', before, after, pnl, 'trade_result', { tradeValue, ...(metadata && typeof metadata === 'object' ? metadata as object : {}) });
  }

  async addActiveTrade(tradeValue: number) {
    this.validateAmount(tradeValue);
    await this.applyAtomicMutation(`
      UPDATE balances
      SET bot_balance = bot_balance - ?, active_trade_balance = active_trade_balance + ?
      WHERE id = 'default' AND bot_balance >= ?
    `, [tradeValue, tradeValue, tradeValue], 'active_trade_addition', tradeValue, 'add_active_trade', undefined, 'Insufficient bot balance');
  }

  async addActiveTradeInTransaction(query: TransactionQuery, tradeValue: number, metadata?: unknown) {
    this.validateAmount(tradeValue);
    const before = await this.readBalances(query);
    const result = await query(`UPDATE balances SET bot_balance = bot_balance - ?, active_trade_balance = active_trade_balance + ? WHERE id = 'default' AND bot_balance >= ?`, [tradeValue, tradeValue, tradeValue]);
    if (result?.changes === 0 || result?.rowCount === 0) throw new Error('Insufficient bot balance for reconciled entry fill');
    const after = await this.readBalances(query);
    await this.logAuditBalance(query, 'active_trade_addition', before, after, tradeValue, 'reconciled_exchange_fill', metadata);
  }

  private validateAmount(amount: number) {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Amount must be a finite non-negative number');
  }
}
