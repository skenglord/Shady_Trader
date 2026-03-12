import { runQuery } from '../database.js';

export interface Balances {
  mainBalance: number;
  botBalance: number;
  activeTradeBalance: number;
  totalPnl: number;
  totalPnlPct: number;
}

export class BalanceManager {
  constructor() {}

  async getBalances(): Promise<Balances> {
    const rows = await runQuery('SELECT * FROM balances WHERE id = ?', ['default'], 'all');
    const row = rows[0];
    const b = {
      mainBalance: row.main_balance,
      botBalance: row.bot_balance,
      activeTradeBalance: row.active_trade_balance,
      totalPnl: row.total_pnl,
      totalPnlPct: row.total_pnl_pct
    };
    console.log(`[BalanceManager] getBalances: botBalance=${b.botBalance}`);
    return b;
  }

  async updateBalances(balances: Partial<Balances>) {
    const current = await this.getBalances();
    const updated = { ...current, ...balances };
    
    await runQuery(`
      UPDATE balances 
      SET main_balance = ?, bot_balance = ?, active_trade_balance = ?, total_pnl = ?, total_pnl_pct = ?
      WHERE id = 'default'
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
    
    await this.updateBalances({
      mainBalance: current.mainBalance - amount,
      botBalance: current.botBalance + amount
    });
  }

  async withdrawFromBot(amount: number) {
    const current = await this.getBalances();
    if (amount > current.botBalance) throw new Error('Insufficient bot balance');
    
    await this.updateBalances({
      mainBalance: current.mainBalance + amount,
      botBalance: current.botBalance - amount
    });
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

    await this.updateBalances({
      botBalance: newBotBalance,
      activeTradeBalance: newActiveTradeBalance,
      totalPnl: newTotalPnl,
      totalPnlPct: newTotalPnlPct
    });
  }

  async addActiveTrade(tradeValue: number) {
    const current = await this.getBalances();
    // Deduct trade value from bot balance and move to active trade balance
    await this.updateBalances({
      botBalance: current.botBalance - tradeValue,
      activeTradeBalance: current.activeTradeBalance + tradeValue
    });
  }
}
