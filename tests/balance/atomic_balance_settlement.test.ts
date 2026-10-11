import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMockRunQuery, setMockRunQuery, setMockRunTransaction } from '../../backend/database.js';
import { BalanceManager } from '../../backend/balance/manager.js';

function installBalanceStore(
  initial: { main: number; bot: number; active: number; pnl?: number },
  options: { failAudit?: boolean } = {},
) {
  const auditRows: Array<Record<string, any>> = [];
  const state: any = { main: initial.main, bot: initial.bot, active: initial.active, pnl: initial.pnl || 0, pnlPct: 0, auditRows };
  const queryState = async (
    target: typeof state,
    targetAuditRows: Array<Record<string, any>>,
    sql: string,
    params: any[] = [],
    type = 'run',
  ) => {
    if (sql.includes('SELECT * FROM balances')) return [{
      main_balance: target.main, bot_balance: target.bot,
      active_trade_balance: target.active, total_pnl: target.pnl, total_pnl_pct: target.pnlPct,
    }];
    if (sql.includes('SET main_balance = main_balance - ?, bot_balance = bot_balance + ?')) {
      const amount = Number(params[0]);
      if (target.main < Number(params[2])) return { changes: 0 };
      target.main -= amount; target.bot += Number(params[1]);
      return { changes: 1 };
    }
    if (sql.includes('SET bot_balance = bot_balance - ?, active_trade_balance = active_trade_balance + ?')) {
      const amount = Number(params[0]);
      if (target.bot < Number(params[2])) return { changes: 0 };
      target.bot -= amount; target.active += Number(params[1]);
      return { changes: 1 };
    }
    if (sql.includes('SET main_balance = main_balance + ?, bot_balance = bot_balance - ?')) {
      const amount = Number(params[0]);
      if (target.bot < Number(params[2])) return { changes: 0 };
      target.main += amount; target.bot -= Number(params[1]);
      return { changes: 1 };
    }
    if (sql.includes('bot_balance = bot_balance + ?,') && sql.includes('total_pnl = total_pnl + ?')) {
      target.bot += Number(params[0]);
      target.active = target.active >= Number(params[1]) ? target.active - Number(params[2]) : 0;
      target.pnl += Number(params[3]);
      target.pnlPct = (target.pnl / (target.main + target.bot)) * 100;
      return { changes: 1 };
    }
    if (sql.includes('INSERT OR REPLACE INTO balances')) {
      [target.main, target.bot, target.active, target.pnl, target.pnlPct] = params.map(Number);
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO audit_balances')) {
      if (options.failAudit) throw new Error('audit insert failed');
      const [id, balanceId, eventType, timestamp, beforeMain, beforeBot, beforeActive,
        afterMain, afterBot, afterActive, changeAmount, reason, metadata] = params;
      targetAuditRows.push({ id, balanceId, eventType, timestamp, beforeMain, beforeBot, beforeActive,
        afterMain, afterBot, afterActive, changeAmount, reason, metadata });
      return { changes: 1 };
    }
    if (type === 'all') return [];
    return { changes: 1 };
  };
  setMockRunQuery((sql, params = [], type = 'run') => queryState(state, auditRows, sql, params, type));

  let transactionQueue: Promise<void> = Promise.resolve();
  setMockRunTransaction(async work => {
    const previous = transactionQueue;
    let release!: () => void;
    transactionQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const nextState = { ...state };
    const nextAuditRows = [...auditRows];
    try {
      const result = await work((sql, params = [], type = 'run') =>
        queryState(nextState, nextAuditRows, sql, params, type));
      Object.assign(state, nextState);
      auditRows.splice(0, auditRows.length, ...nextAuditRows);
      return result;
    } finally {
      release();
    }
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

  test('writes one audit record for a committed balance mutation', async () => {
    const state = installBalanceStore({ main: 1000, bot: 0, active: 0 });
    const manager = new BalanceManager();
    await manager.allocateToBot(250);
    assert.equal(state.main, 750);
    assert.equal(state.bot, 250);
    assert.equal(state.auditRows.length, 1);
    assert.deepEqual({
      eventType: state.auditRows[0].eventType,
      beforeMain: state.auditRows[0].beforeMain,
      beforeBot: state.auditRows[0].beforeBot,
      afterMain: state.auditRows[0].afterMain,
      afterBot: state.auditRows[0].afterBot,
      changeAmount: state.auditRows[0].changeAmount,
    }, {
      eventType: 'allocation', beforeMain: 1000, beforeBot: 0,
      afterMain: 750, afterBot: 250, changeAmount: 250,
    });
  });

  test('does not audit an insufficient-balance mutation', async () => {
    const state = installBalanceStore({ main: 100, bot: 0, active: 0 });
    const manager = new BalanceManager();
    await assert.rejects(manager.allocateToBot(250), /Insufficient main balance/);
    assert.equal(state.main, 100);
    assert.equal(state.bot, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('rolls back a balance mutation when its audit insert fails', async () => {
    const state = installBalanceStore({ main: 1000, bot: 0, active: 0 }, { failAudit: true });
    const manager = new BalanceManager();
    await assert.rejects(manager.allocateToBot(250), /audit insert failed/);
    assert.equal(state.main, 1000);
    assert.equal(state.bot, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('validates the current bot balance before doubling it', async () => {
    const state = installBalanceStore({ main: 100, bot: -1, active: 0 });
    const manager = new BalanceManager();
    await assert.rejects(manager.doubleBotBalance(), /Amount must be a finite non-negative number/);
    assert.equal(state.main, 100);
    assert.equal(state.bot, -1);
    assert.equal(state.auditRows.length, 0);
  });
});
