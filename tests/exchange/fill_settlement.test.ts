import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMockRunQuery, setMockRunQuery, setMockRunTransaction } from '../../backend/database.js';
import { BalanceManager } from '../../backend/balance/manager.js';
import { applyExchangeFill } from '../../backend/exchange/fill-settlement.js';

const scope = { exchange: 'binance', accountId: 'binance:testnet:unit' };
const fill = (id: string, qty: number, price: number, side: 'buy' | 'sell' = 'buy') => ({ exchangeOrderId: 'order-1', exchangeFillId: id, clientOrderId: 'client-1', symbol: 'BTC/USDT', side, quantity: qty, price, fee: 0, feeCurrency: 'USDT', timestamp: Date.now() });

function installStore(options: { failAudit?: boolean } = {}) {
  const original = {
    intents: [{ idempotency_key: 'intent-1', trade_id: 'trade-1', parent_trade_id: null as string | null, exchange_name: scope.exchange, account_id: scope.accountId, exchange_order_id: 'order-1', client_order_id: 'client-1', intent_type: 'entry', side: 'buy', symbol: 'BTC/USDT', requested_quantity: 2, filled_quantity: 0, average_fill_price: null as number | null, status: 'submitted', created_at: 1 }],
    trades: [{ id: 'trade-1', exchange_name: scope.exchange, account_id: scope.accountId, amount: 2, remaining_amount: 0, price: 100, side: 'buy', status: 'pending', leverage: 1, realized_pnl: 0 }],
    fills: [] as any[], audits: [] as any[], balance: { main_balance: 1000, bot_balance: 500, active_trade_balance: 200, total_pnl: 0, total_pnl_pct: 0 },
  };
  const query = async (state: typeof original, sql: string, params: any[] = [], type: 'run' | 'all' = 'run') => {
    if (sql.includes('SELECT * FROM balances')) return [state.balance];
    if (sql.includes('SELECT * FROM execution_intents')) return state.intents.filter(i => i.exchange_name === params[0] && i.account_id === params[1] && (i.exchange_order_id === params[2] || i.client_order_id === params[3])).slice(0, 2);
    if (sql.includes('SELECT 1 FROM exchange_fills')) return state.fills.some(f => f.exchange_fill_id === params[3] && f.exchange_order_id === params[2] && f.account_id === params[1]) ? [{}] : [];
    if (sql.includes('INSERT INTO exchange_fills')) { state.fills.push({ exchange_name: params[0], account_id: params[1], exchange_order_id: params[2], exchange_fill_id: params[3] }); return { changes: 1 }; }
    if (sql.includes('UPDATE execution_intents SET filled_quantity')) { const i = state.intents.find(row => row.idempotency_key === params[4])!; i.filled_quantity = params[0]; i.average_fill_price = params[1]; i.status = params[3]; return { changes: 1 }; }
    if (sql.includes('SELECT * FROM shadow_trades')) return state.trades.filter(t => t.id === params[0] && t.exchange_name === params[1] && t.account_id === params[2]);
    if (sql.includes("UPDATE shadow_trades SET amount = ?")) { const t = state.trades.find(row => row.id === params[3])!; t.amount = params[0]; t.remaining_amount = params[1]; t.price = params[2]; t.status = 'open'; return { changes: 1 }; }
    if (sql.includes('UPDATE shadow_trades SET remaining_amount')) { const t = state.trades.find(row => row.id === params[9])!; t.remaining_amount = params[0]; t.realized_pnl = params[1]; t.status = params[2]; return { changes: 1 }; }
    if (sql.includes('bot_balance = bot_balance + ?,') && sql.includes('total_pnl = total_pnl + ?')) { state.balance.bot_balance += Number(params[0]); state.balance.active_trade_balance -= Number(params[1]); state.balance.total_pnl += Number(params[3]); return { changes: 1 }; }
    if (sql.includes('SET bot_balance = bot_balance - ?')) { if (state.balance.bot_balance < Number(params[0])) return { changes: 0 }; state.balance.bot_balance -= Number(params[0]); state.balance.active_trade_balance += Number(params[1]); return { changes: 1 }; }
    if (sql.includes('INSERT INTO audit_balances')) { if (options.failAudit) throw new Error('audit failed'); state.audits.push(params); return { changes: 1 }; }
    if (type === 'all') return [];
    return { changes: 1 };
  };
  setMockRunQuery((sql, params = [], type = 'run') => query(original, sql, params, type));
  setMockRunTransaction(async work => {
    const tx = structuredClone(original);
    const result = await work((sql, params = [], type = 'run') => query(tx, sql, params, type));
    Object.assign(original, tx);
    return result;
  });
  return original;
}

afterEach(() => clearMockRunQuery());

test('entry fills update actual quantity and replay only once', async () => {
  const state = installStore();
  const manager = new BalanceManager();
  assert.equal(await applyExchangeFill(fill('fill-a', 0.5, 100), scope, manager), 'applied');
  assert.equal(await applyExchangeFill(fill('fill-a', 0.5, 100), scope, manager), 'duplicate');
  assert.equal(state.trades[0].amount, 0.5);
  assert.equal(state.trades[0].remaining_amount, 0.5);
  assert.equal(state.fills.length, 1);
  assert.equal(state.audits.length, 1, 'entry principal reservation is audited transactionally');
  assert.equal(state.balance.bot_balance, 450);
  assert.equal(state.balance.active_trade_balance, 250);
});

test('partial exit fills retain the open trade and apply realized PnL through the transaction query', async () => {
  const state = installStore();
  state.intents[0].intent_type = 'exit';
  state.intents[0].side = 'sell';
  state.intents[0].trade_id = 'trade-1:close';
  state.intents[0].parent_trade_id = 'trade-1';
  state.intents[0].filled_quantity = 0;
  state.trades[0].remaining_amount = 2;
  assert.equal(await applyExchangeFill(fill('fill-exit', 0.5, 110, 'sell'), scope, new BalanceManager()), 'applied');
  assert.equal(state.trades[0].remaining_amount, 1.5);
  assert.equal(state.trades[0].realized_pnl, 5);
  assert.equal(state.trades[0].status, 'open');
  assert.equal(state.balance.total_pnl, 5);
  assert.equal(state.audits.length, 1);
});

test('fills without a unique matching scoped intent remain unmatched', async () => {
  const state = installStore();
  state.intents[0].account_id = 'other-account';
  assert.equal(await applyExchangeFill(fill('outside', 1, 100), scope, new BalanceManager()), 'unmatched');
  assert.equal(state.fills.length, 0);
});

test('quote-currency rebates reduce entry cost without changing filled quantity', async () => {
  const state = installStore();
  const rebate = { ...fill('rebate-fill', 0.5, 100), fee: -2, feeCurrency: 'USDT' };
  assert.equal(await applyExchangeFill(rebate, scope, new BalanceManager()), 'applied');
  assert.equal(state.trades[0].remaining_amount, 0.5);
  assert.equal(state.trades[0].price, 96);
  assert.equal(state.balance.active_trade_balance, 248);
});

test('rebates in an unvalued currency remain unmatched', async () => {
  const state = installStore();
  const rebate = { ...fill('unvalued-rebate', 0.5, 100), fee: -0.01, feeCurrency: 'BNB' };
  assert.equal(await applyExchangeFill(rebate, scope, new BalanceManager()), 'unmatched');
  assert.equal(state.fills.length, 0);
});

test('audit failure rolls back fill claim and trade update', async () => {
  const state = installStore({ failAudit: true });
  state.intents[0].intent_type = 'exit';
  state.intents[0].side = 'sell';
  state.intents[0].trade_id = 'trade-1:close';
  state.intents[0].parent_trade_id = 'trade-1';
  state.trades[0].remaining_amount = 2;
  await assert.rejects(() => applyExchangeFill(fill('rollback-fill', 0.5, 110, 'sell'), scope, new BalanceManager()), /audit failed/);
  assert.equal(state.fills.length, 0);
  assert.equal(state.trades[0].remaining_amount, 2);
  assert.equal(state.balance.total_pnl, 0);
});
