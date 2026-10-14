import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { createShadowTestStore } from '../utils/shadow-sqlite-store.js';
import { clearMockRunQuery } from '../../backend/database.js';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';
import { BalanceManager } from '../../backend/balance/manager.js';
import { getDailyRealizedLoss, RiskMode } from '../../backend/risk/manager.js';

let db: Database.Database;
const previousEnv = { ...process.env };
beforeEach(() => {
  process.env.LIVE_TRADING_ENABLED = 'false';
  process.env.TAKER_FEE_RATE = '0';
  process.env.FIXED_SLIPPAGE_FALLBACK = '0';
  db = createShadowTestStore().db;
});
afterEach(() => {
  clearMockRunQuery();
  db.close();
  for (const key of ['LIVE_TRADING_ENABLED', 'TAKER_FEE_RATE', 'FIXED_SLIPPAGE_FALLBACK']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function stage(trader: ShadowTrader, overrides: Record<string, any> = {}) {
  const trade = {
    id: 'runner', symbol: 'BTC/USDT', side: 'buy', amount: 1, price: 100,
    leverage: 2, stopLoss: 97, takeProfit: 103, risk_mode: RiskMode.AGGRESSIVE,
    status: 'open', candlesHeld: 0, totalFeeFrac: 0, wallet_owned: 1,
    ...overrides,
  };
  const reserved = trade.wallet_owned ? trade.amount * trade.price / trade.leverage : 0;
  db.prepare(`INSERT INTO shadow_trades
    (id,symbol,side,amount,remaining_amount,price,leverage,stop_loss,take_profit,
     risk_mode,status,total_fee_frac,timestamp,wallet_owned,reserved_margin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(trade.id, trade.symbol, trade.side,
    trade.amount, trade.amount, trade.price, trade.leverage, trade.stopLoss,
    trade.takeProfit, trade.risk_mode, trade.status, trade.totalFeeFrac, Date.now(),
    trade.wallet_owned, reserved);
  if (reserved) await new BalanceManager().addActiveTrade(reserved);
  trader.portfolios[trade.risk_mode as RiskMode].openTrades.push(trade);
  return trade;
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('runner partial plus same-cycle exit realizes exactly the executed one-unit gain', async () => {
  const trader = new ShadowTrader();
  await stage(trader);
  await trader.updatePositions(102, RiskMode.AGGRESSIVE, new BalanceManager());
  near(trader.portfolios.aggressive.balance, 100002);
  const wallet = await new BalanceManager().getBalances();
  near(wallet.botBalance, 1002);
  near(wallet.activeTradeBalance, 0);
  near(wallet.totalPnl, 2);
  const row: any = db.prepare('SELECT * FROM shadow_trades').get();
  near(row.pnl, 2);
  assert.equal(row.remaining_amount, 0);
});

test('restart restores runner quantity, stops, fee basis and realized PnL before final exit', async () => {
  const trader = new ShadowTrader();
  trader.riskManager.getConfig(RiskMode.AGGRESSIVE).earlyExitEnabled = false;
  await stage(trader, { totalFeeFrac: 0.001 });
  await trader.updatePositions(102, RiskMode.AGGRESSIVE, new BalanceManager(), undefined, { time: 100 });
  const restarted = new ShadowTrader();
  await restarted.loadState();
  const remaining = restarted.portfolios.aggressive.openTrades[0];
  near(remaining.amount, 0.4);
  assert.equal(remaining.isRunner, true);
  assert.equal(remaining.candlesHeld, 1);
  assert.equal(remaining.lastUpdateTime, 100);
  near(remaining.stopLoss, 101.592);
  near(remaining.totalFeeFrac, 0.001);
  near(restarted.portfolios.aggressive.balance, 100001.14);
  await restarted.closeTrade(remaining.id, 101, RiskMode.MODERATE, new BalanceManager());
  near((await new BalanceManager().getBalances()).botBalance, 1001.5);
  near((db.prepare('SELECT pnl FROM shadow_trades').get() as any).pnl, 1.5);
  await restarted.loadState();
  near(restarted.portfolios.aggressive.balance, 100001.5);
});

test('mode switch and restart settle only the original wallet reservation', async () => {
  const trader = new ShadowTrader();
  await stage(trader, { id: 'owned', leverage: 1, risk_mode: RiskMode.MODERATE });
  await stage(trader, { id: 'shadow', leverage: 1, amount: 2, wallet_owned: 0 });
  const restarted = new ShadowTrader();
  await restarted.loadState();
  await restarted.closeTrade('owned', 100, RiskMode.AGGRESSIVE, new BalanceManager());
  await restarted.closeTrade('shadow', 100, RiskMode.AGGRESSIVE, new BalanceManager());
  const wallet = await new BalanceManager().getBalances();
  near(wallet.botBalance, 1000);
  near(wallet.activeTradeBalance, 0);
  near(wallet.totalPnl, 0);
});

test('wallet rejects release beyond reserved principal without changing any balance', async () => {
  const manager = new BalanceManager();
  await manager.addActiveTrade(100);
  const before = await manager.getBalances();
  await assert.rejects(manager.recordTradeResult(0, 200), /reserved|active trade|principal/i);
  assert.deepEqual(await manager.getBalances(), before);
});

test('failed runner settlement leaves cash, quantity and portfolio untouched', async () => {
  const trader = new ShadowTrader();
  const trade = await stage(trader);
  db.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_balances
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
  await assert.rejects(trader.updatePositions(102, RiskMode.AGGRESSIVE, new BalanceManager()), /audit unavailable/);
  assert.equal(trade.amount, 1);
  assert.equal(trade.stopLoss, 97);
  assert.equal(trader.portfolios.aggressive.balance, 100000);
  assert.equal((await new BalanceManager().getBalances()).activeTradeBalance, 50);
  assert.equal((db.prepare('SELECT remaining_amount FROM shadow_trades').get() as any).remaining_amount, 1);
});

test('concurrent trader instances cannot settle a reservation twice', async () => {
  const first = new ShadowTrader();
  await stage(first, { leverage: 1 });
  const second = new ShadowTrader();
  await second.loadState();
  await Promise.allSettled([
    first.closeTrade('runner', 102, RiskMode.AGGRESSIVE, new BalanceManager()),
    second.closeTrade('runner', 102, RiskMode.AGGRESSIVE, new BalanceManager()),
  ]);
  const wallet = await new BalanceManager().getBalances();
  near(wallet.botBalance, 1002);
  near(wallet.totalPnl, 2);
  near(wallet.activeTradeBalance, 0);
});

test('daily loss marks BTC and ETH at their own prices in either loss direction', async () => {
  await stage(new ShadowTrader(), { id: 'btc', price: 50000, wallet_owned: 0 });
  await stage(new ShadowTrader(), { id: 'eth', symbol: 'ETH/USDT', price: 3000, wallet_owned: 0 });
  for (const [btc, eth, expected] of [[50000, 3000, 0], [49000, 3100, 900], [51000, 1900, 100]]) {
    const prices: Record<string, number> = { 'BTC/USDT': btc, 'ETH/USDT': eth };
    const loss = await getDailyRealizedLoss(RiskMode.AGGRESSIVE, Date.now(), (async (symbol: string) => prices[symbol]) as any);
    near(loss, expected);
  }
});

test('daily loss fails closed when a symbol mark is unavailable or invalid', async () => {
  await stage(new ShadowTrader(), { wallet_owned: 0 });
  for (const mark of [undefined, NaN, Infinity, 0, -1]) {
    await assert.rejects(getDailyRealizedLoss(RiskMode.AGGRESSIVE, Date.now(), (async () => mark) as any), /price|mark/i);
  }
});
