import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMockRunQuery, setMockRunQuery } from '../../backend/database.js';
import { BalanceManager } from '../../backend/balance/manager.js';

function installBalanceStore(initial: { main: number; bot: number; active: number; pnl?: number }) {
  const state = { main: initial.main, bot: initial.bot, active: initial.active, pnl: initial.pnl || 0, pnlPct: 0 };
  setMockRunQuery(async (sql: string, params: any[] = [], type = 'run') => {
    if (sql.includes('SELECT * FROM balances')) return [{
      main_balance: state.main, bot_balance: state.bot,
      active_trade_balance: state.active, total_pnl: state.pnl, total_pnl_pct: state.pnlPct,
    }];
    if (sql.includes('SET main_balance = main_balance - ?, bot_balance = bot_balance + ?')) {
      const amount = Number(params[0]);
      if (state.main < Number(params[2])) return { changes: 0 };
      state.main -= amount; state.bot += Number(params[1]);
      return { changes: 1 };
    }
    if (sql.includes('SET bot_balance = bot_balance - ?, active_trade_balance = active_trade_balance + ?')) {
      const amount = Number(params[0]);
      if (state.bot < Number(params[2])) return { changes: 0 };
      state.bot -= amount; state.active += Number(params[1]);
      return { changes: 1 };
    }
    if (sql.includes('bot_balance = bot_balance + ?,') && sql.includes('total_pnl = total_pnl + ?')) {
      state.bot += Number(params[0]);
      state.active = state.active >= Number(params[1]) ? state.active - Number(params[2]) : 0;
      state.pnl += Number(params[3]);
      state.pnlPct = (state.pnl / (state.main + state.bot)) * 100;
      return { changes: 1 };
    }
    if (sql.includes('INSERT OR REPLACE INTO balances')) {
      [state.main, state.bot, state.active, state.pnl, state.pnlPct] = params.map(Number);
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO audit_balances')) return { changes: 1 };
    if (type === 'all') return [];
    return { changes: 1 };
  });
  return state;
}

afterEach(() => clearMockRunQuery());

describe('atomic balance settlement', () => {
  test('concurrent active-trade reservations are both retained', async () => {
    const state = installBalanceStore({ main: 1000, bot: 1000, active: 0 });
    const manager = new BalanceManager();
    await Promise.all([manager.addActiveTrade(100), manager.addActiveTrade(100)]);
    assert.equal(state.bot, 800);
    assert.equal(state.active, 200);
  });

  test('concurrent trade settlements do not overwrite returned principal or PnL', async () => {
    const state = installBalanceStore({ main: 1000, bot: 800, active: 200 });
    const manager = new BalanceManager();
    await Promise.all([manager.recordTradeResult(10, 100), manager.recordTradeResult(-5, 100)]);
    assert.equal(state.bot, 1005);
    assert.equal(state.active, 0);
    assert.equal(state.pnl, 5);
  });

  test('concurrent allocations cannot spend the same main-balance funds twice', async () => {
    const state = installBalanceStore({ main: 1000, bot: 0, active: 0 });
    const manager = new BalanceManager();
    const results = await Promise.allSettled([manager.allocateToBot(600), manager.allocateToBot(600)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(state.main, 400);
    assert.equal(state.bot, 600);
  });
});
