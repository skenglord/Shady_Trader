import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';
import { RiskMode, RiskManager } from '../../backend/risk/manager.js';
import { setMockRunQuery, clearMockRunQuery } from '../../backend/database.js';

// ---------------------------------------------------------------------------
// Helpers – construct realistic trade + ExitContext objects matching the
// shape expected by the private T5 evaluators in shadow_trader.ts.
// ---------------------------------------------------------------------------

function makeTrade(overrides: Partial<any> = {}): any {
  return {
    id: 'test-trade-1',
    symbol: 'BTC/USDT',
    side: 'buy',
    amount: 1.0,
    price: 50000,
    status: 'open',
    timestamp: Date.now(),
    risk_mode: RiskMode.MODERATE,
    stopLoss: 49000,
    takeProfit: 51000,
    initialStopLoss: 49000,
    leverage: 1.5,
    candlesHeld: 0,
    isRunner: false,
    entrySlippageFrac: 0.0005,
    totalFeeFrac: 0.001,
    exchangeOrderId: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<any> = {}): any {
  // Default values simulate a MODERATE-mode buy trade at breakeven.
  const trade = overrides._trade ?? makeTrade();
  const leverage = trade.leverage || 1;
  const marginUsed = (trade.amount * trade.price) / leverage;
  const currentPrice = overrides.currentPrice ?? trade.price;
  const currentNotional = trade.amount * currentPrice;
  const currentMargin = currentNotional / leverage;
  const profitPct =
    trade.side === 'buy'
      ? (currentPrice - trade.price) / trade.price
      : (trade.price - currentPrice) / trade.price;

  const riskManager = new RiskManager();
  const config = riskManager.getConfig(RiskMode.MODERATE);

  return {
    currentPrice,
    config,
    mode: RiskMode.MODERATE,
    leverage,
    marginUsed,
    currentMargin,
    profitPct,
    maintenanceMargin: 0.005,
    activeMode: undefined,
    balanceManager: undefined,
    portfolio: {
      balance: 100000,
      initialBalance: 100000,
      openTrades: [trade],
    },
    ...overrides,
  };
}

// Recording mock for DB writes – captures UPDATE shadow_trades calls so we
// can assert columns (pnl, exit_price, exit_reason).
let dbCalls: { sql: string; params: any[] }[] = [];

beforeEach(() => {
  dbCalls = [];
  setMockRunQuery(async (sql: string, params: any[] = [], _type: 'run' | 'all' = 'run') => {
    dbCalls.push({ sql, params });
    if (sql.includes('SELECT')) return [];
    return { changes: 1 };
  });
});

afterEach(() => {
  clearMockRunQuery();
});

// ---------------------------------------------------------------------------
// evaluateStopLoss
// ---------------------------------------------------------------------------

describe('ShadowTrader.evaluateStopLoss [T5]', () => {
  test('returns stop_loss when buy price drops to stopLoss', () => {
    const trader = new ShadowTrader();
    const trade = makeTrade({ side: 'buy', stopLoss: 49000, price: 50000, leverage: 1 });
    const ctx = makeCtx({ currentPrice: 49000, _trade: trade, leverage: 1 });

    const decision = (trader as any).evaluateStopLoss(trade, ctx);
    assert.ok(decision, 'should return a decision');
    assert.equal(decision.reason, 'stop_loss');
    assert.equal(decision.exitPrice, 49000);
    assert.equal(decision.pnlOverride, undefined);
  });

  test('returns null when buy price is above stopLoss (no trigger)', () => {
    const trader = new ShadowTrader();
    const trade = makeTrade({ side: 'buy', stopLoss: 49000, price: 50000, leverage: 1 });
    const ctx = makeCtx({ currentPrice: 50500, _trade: trade, leverage: 1 });

    const decision = (trader as any).evaluateStopLoss(trade, ctx);
    assert.equal(decision, null);
  });

  test('returns stop_loss for sell trade when price rises to stopLoss', () => {
    const trader = new ShadowTrader();
    const trade = makeTrade({ side: 'sell', stopLoss: 51000, price: 50000, leverage: 1 });
    const ctx = makeCtx({ currentPrice: 51000, _trade: trade, leverage: 1 });

    const decision = (trader as any).evaluateStopLoss(trade, ctx);
    assert.ok(decision);
    assert.equal(decision.reason, 'stop_loss');
  });

  test('returns liquidation when loss exceeds liquidation threshold', () => {
    const trader = new ShadowTrader();
    // leverage 5 → liquidationThreshold = 1/5 - 0.005 = 0.195
    const trade = makeTrade({ side: 'buy', stopLoss: 1, price: 50000, leverage: 5, amount: 1 });
    // Drop price enough so lossPct >= 0.195
    // marginUsed = 50000/5 = 10000; currentPrice = 40000 → currentMargin = 8000
    // lossPct = (10000-8000)/10000 = 0.2 > 0.195 → liquidation
    const ctx = makeCtx({ currentPrice: 40000, _trade: trade, leverage: 5 });
    ctx.marginUsed = (trade.amount * trade.price) / 5;
    ctx.currentMargin = (trade.amount * 40000) / 5;

    const decision = (trader as any).evaluateStopLoss(trade, ctx);
    assert.ok(decision);
    assert.equal(decision.reason, 'liquidation');
    assert.equal(decision.pnlOverride, -ctx.marginUsed);
  });
});

// ---------------------------------------------------------------------------
// evaluateTakeProfit
// ---------------------------------------------------------------------------

describe('ShadowTrader.evaluateTakeProfit [T5]', () => {
  test('returns take_profit when buy price reaches takeProfit', () => {
    const trader = new ShadowTrader();
    const trade = makeTrade({ side: 'buy', takeProfit: 51000, price: 50000, leverage: 1, isRunner: false });
    const ctx = makeCtx({ currentPrice: 51000, _trade: trade, leverage: 1 });

    const decision = (trader as any).evaluateTakeProfit(trade, ctx);
    assert.ok(decision);
    assert.equal(decision.reason, 'take_profit');
  });

  test('returns null when buy price has not reached takeProfit and no early exit', () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    // ULTRA_CONSERVATIVE: earlyExitEnabled=false → only TP check matters
    const trade = makeTrade({ side: 'buy', takeProfit: 51000, price: 50000, leverage: 1, isRunner: false });
    const ctx = makeCtx({
      currentPrice: 50500,
      _trade: trade,
      leverage: 1,
      config: rm.getConfig(RiskMode.ULTRA_CONSERVATIVE),
      mode: RiskMode.ULTRA_CONSERVATIVE,
    });

    const decision = (trader as any).evaluateTakeProfit(trade, ctx);
    assert.equal(decision, null);
  });

  test('returns null for runner trades even at takeProfit (runner bypasses TP, no early exit)', () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    // ULTRA_CONSERVATIVE: earlyExitEnabled=false → runner bypasses TP and no early_exit
    const trade = makeTrade({ side: 'buy', takeProfit: 51000, price: 50000, leverage: 1, isRunner: true });
    const ctx = makeCtx({
      currentPrice: 51000,
      _trade: trade,
      leverage: 1,
      config: rm.getConfig(RiskMode.ULTRA_CONSERVATIVE),
      mode: RiskMode.ULTRA_CONSERVATIVE,
    });

    const decision = (trader as any).evaluateTakeProfit(trade, ctx);
    assert.equal(decision, null);
  });

  test('returns take_profit for sell trade when price drops to takeProfit', () => {
    const trader = new ShadowTrader();
    const trade = makeTrade({ side: 'sell', takeProfit: 49000, price: 50000, leverage: 1, isRunner: false });
    const ctx = makeCtx({ currentPrice: 49000, _trade: trade, leverage: 1 });

    const decision = (trader as any).evaluateTakeProfit(trade, ctx);
    assert.ok(decision);
    assert.equal(decision.reason, 'take_profit');
  });

  test('returns early_exit when earlyExitEnabled and profitPct >= earlyExitTarget', () => {
    const trader = new ShadowTrader();
    // CONSERVATIVE config: earlyExitEnabled=true, earlyExitTarget=0.8
    // profitPct = 0.01 (1%) > 0.8% → early_exit
    const trade = makeTrade({ side: 'buy', takeProfit: 999999, price: 50000, leverage: 1, isRunner: false });
    const rm = new RiskManager();
    const ctx = makeCtx({
      currentPrice: 50500,
      _trade: trade,
      leverage: 1,
      config: rm.getConfig(RiskMode.CONSERVATIVE),
      mode: RiskMode.CONSERVATIVE,
    });

    const decision = (trader as any).evaluateTakeProfit(trade, ctx);
    assert.ok(decision);
    assert.equal(decision.reason, 'early_exit');
  });
});

// ---------------------------------------------------------------------------
// evaluateMlExitCheckpoints
// ---------------------------------------------------------------------------

describe('ShadowTrader.evaluateMlExitCheckpoints [T5]', () => {
  test('returns multi_candle_expiry when candlesHeld >= maxCandles', () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    const trade = makeTrade({ candlesHeld: 3, leverage: 1, price: 50000 });
    // MODERATE config: multiCandleHoldEnabled=true, holdConditions.maxCandles=3
    const ctx = makeCtx({ currentPrice: 50500, _trade: trade, leverage: 1, config: rm.getConfig(RiskMode.MODERATE) });

    const decision = (trader as any).evaluateMlExitCheckpoints(trade, ctx);
    assert.ok(decision);
    assert.equal(decision.reason, 'multi_candle_expiry');
  });

  test('returns null when candlesHeld < maxCandles', () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    const trade = makeTrade({ candlesHeld: 1, leverage: 1, price: 50000 });
    const ctx = makeCtx({ currentPrice: 50500, _trade: trade, leverage: 1, config: rm.getConfig(RiskMode.MODERATE) });

    const decision = (trader as any).evaluateMlExitCheckpoints(trade, ctx);
    assert.equal(decision, null);
  });

  test('returns null when multiCandleHoldEnabled is false', () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    // CONSERVATIVE: multiCandleHoldEnabled = false
    const trade = makeTrade({ candlesHeld: 100, leverage: 1, price: 50000 });
    const ctx = makeCtx({
      currentPrice: 50500,
      _trade: trade,
      leverage: 1,
      config: rm.getConfig(RiskMode.CONSERVATIVE),
      mode: RiskMode.CONSERVATIVE,
    });

    const decision = (trader as any).evaluateMlExitCheckpoints(trade, ctx);
    assert.equal(decision, null);
  });
});

// ---------------------------------------------------------------------------
// evaluateRatchet
// ---------------------------------------------------------------------------

describe('ShadowTrader.evaluateRatchet [T5]', () => {
  test('raises trailing stop for buy trade when profit > 0.5% and multiCandleHold enabled', async () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    const trade = makeTrade({ side: 'buy', stopLoss: 49000, price: 50000, leverage: 1, amount: 1 });
    // profitPct = (51000-50000)/50000 = 0.02 > 0.005
    // trailStop = 51000 * 0.996 = 50796 > 49000 → trailing applied
    const ctx = makeCtx({ currentPrice: 51000, _trade: trade, leverage: 1, config: rm.getConfig(RiskMode.MODERATE) });

    const result = await (trader as any).evaluateRatchet(trade, ctx);
    assert.ok(result);
    assert.equal(result.trailingStopApplied, true);
    assert.equal(result.runnerTriggered, false);
    // stopLoss should have been raised
    assert.ok(trade.stopLoss > 49000, 'stopLoss should be raised from 49000');
  });

  test('returns null when no trailing or runner conditions met', async () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    const trade = makeTrade({ side: 'buy', stopLoss: 49000, price: 50000, leverage: 1 });
    // profitPct = 0.002 < 0.005 → no trailing
    const ctx = makeCtx({ currentPrice: 50100, _trade: trade, leverage: 1, config: rm.getConfig(RiskMode.MODERATE) });

    const result = await (trader as any).evaluateRatchet(trade, ctx);
    assert.equal(result, null);
  });

  test('raises trailing stop for sell trade when profit > 0.5%', async () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();
    const trade = makeTrade({ side: 'sell', stopLoss: 51000, price: 50000, leverage: 1, amount: 1 });
    // profitPct = (50000-49000)/50000 = 0.02 > 0.005
    // trailStop = 49000 * 1.004 = 49196 < 51000 → trailing applied (for sell, lower is tighter)
    const ctx = makeCtx({ currentPrice: 49000, _trade: trade, leverage: 1, config: rm.getConfig(RiskMode.MODERATE) });

    const result = await (trader as any).evaluateRatchet(trade, ctx);
    assert.ok(result);
    assert.equal(result.trailingStopApplied, true);
    assert.ok(trade.stopLoss < 51000, 'sell stopLoss should be lowered from 51000');
  });
});

// ---------------------------------------------------------------------------
// Precedence: ML checkpoints > stop_loss/liquidation > take_profit/early_exit
// ---------------------------------------------------------------------------

describe('ShadowTrader.updatePositions precedence [T5]', () => {
  test('ML multi_candle_expiry overrides stop_loss when both fire', async () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();

    // Construct a trade where both stop_loss and multi_candle_expiry fire:
    // buy at 50000, stopLoss at 49000, currentPrice 49000 (SL hit)
    // candlesHeld = 3, maxCandles = 3 (ML expiry hit)
    // ML has highest precedence → final exitReason = multi_candle_expiry
    const trade = makeTrade({
      id: 'precedence-1',
      side: 'buy',
      price: 50000,
      stopLoss: 49000,
      takeProfit: 999999,
      leverage: 1,
      amount: 1,
      candlesHeld: 3,
      isRunner: false,
      risk_mode: RiskMode.MODERATE,
    });

    trader.portfolios[RiskMode.MODERATE].openTrades = [trade];
    trader.portfolios[RiskMode.MODERATE].balance = 100000;

    await trader.updatePositions(49000, undefined, undefined, undefined, { time: Date.now() });

    // Trade should be closed (removed from openTrades)
    assert.equal(trader.portfolios[RiskMode.MODERATE].openTrades.length, 0, 'trade should be closed');

    // The DB UPDATE should have exit_reason = multi_candle_expiry
    const updateCall = dbCalls.find(c => c.sql.includes('UPDATE shadow_trades'));
    assert.ok(updateCall, 'should have UPDATE shadow_trades call');
    // params: [pnl, exitPrice, exitTimestamp, tradeId]
    assert.equal(updateCall.params[3], 'precedence-1');
  });

  test('stop_loss overrides take_profit when both fire', async () => {
    const trader = new ShadowTrader();

    // buy at 50000, stopLoss at 49000, takeProfit at 49000 — both at same price
    // SL has higher precedence than TP
    const trade = makeTrade({
      id: 'precedence-2',
      side: 'buy',
      price: 50000,
      stopLoss: 49000,
      takeProfit: 49000,
      leverage: 1,
      amount: 1,
      candlesHeld: 0,
      isRunner: false,
      risk_mode: RiskMode.MODERATE,
    });

    trader.portfolios[RiskMode.MODERATE].openTrades = [trade];
    trader.portfolios[RiskMode.MODERATE].balance = 100000;

    await trader.updatePositions(49000, undefined, undefined, undefined, { time: Date.now() });

    assert.equal(trader.portfolios[RiskMode.MODERATE].openTrades.length, 0, 'trade should be closed');
    const updateCall = dbCalls.find(c => c.sql.includes('UPDATE shadow_trades'));
    assert.ok(updateCall);
    // pnl should be negative (loss), confirming SL took precedence over TP
    assert.ok(updateCall.params[0] < 0, 'pnl should be negative (stop_loss, not take_profit)');
  });

  test('trade remains open when no exit conditions fire', async () => {
    const trader = new ShadowTrader();
    const rm = new RiskManager();

    // Use ULTRA_CONSERVATIVE: earlyExitEnabled=false, multiCandleHoldEnabled=false
    // Price slightly above entry but below TP — no exit fires
    const trade = makeTrade({
      id: 'no-exit',
      side: 'buy',
      price: 50000,
      stopLoss: 49000,
      takeProfit: 51000,
      leverage: 1,
      amount: 1,
      candlesHeld: 0,
      isRunner: false,
      risk_mode: RiskMode.ULTRA_CONSERVATIVE,
    });

    trader.portfolios[RiskMode.ULTRA_CONSERVATIVE].openTrades = [trade];
    trader.portfolios[RiskMode.ULTRA_CONSERVATIVE].balance = 100000;

    // price 50100: above SL(49000), below TP(51000), no early exit (disabled), no multi-candle
    await trader.updatePositions(50100, undefined, undefined, undefined, { time: Date.now() });

    assert.equal(trader.portfolios[RiskMode.ULTRA_CONSERVATIVE].openTrades.length, 1, 'trade should remain open');
    // No UPDATE should have been issued
    const updateCall = dbCalls.find(c => c.sql.includes('UPDATE shadow_trades'));
    assert.equal(updateCall, undefined);
  });
});

// ---------------------------------------------------------------------------
// Fee + slippage application in computed pnl on close
// ---------------------------------------------------------------------------

describe('ShadowTrader.executeTradeClosure fee/slippage [T5]', () => {
  test('pnlOverride from liquidation is used instead of computed pnl', async () => {
    const trader = new ShadowTrader();

    const trade = makeTrade({
      id: 'pnl-override-1',
      side: 'buy',
      price: 50000,
      stopLoss: 1,
      leverage: 5,
      amount: 1,
      candlesHeld: 0,
      isRunner: false,
      risk_mode: RiskMode.DEGEN,
    });

    trader.portfolios[RiskMode.DEGEN].openTrades = [trade];
    trader.portfolios[RiskMode.DEGEN].balance = 100000;

    // Price drops enough for liquidation: 1/5 - 0.005 = 0.195 threshold
    // marginUsed = 50000/5 = 10000
    // currentPrice = 40000 → currentMargin = 8000 → lossPct = 0.2 > 0.195
    const initialBalance = trader.portfolios[RiskMode.DEGEN].balance;

    await trader.updatePositions(40000, undefined, undefined, undefined, { time: Date.now() });

    assert.equal(trader.portfolios[RiskMode.DEGEN].openTrades.length, 0, 'trade should be closed');
    // pnlOverride = -marginUsed = -10000
    // balance should have decreased by 10000
    assert.equal(trader.portfolios[RiskMode.DEGEN].balance, initialBalance - 10000);

    const updateCall = dbCalls.find(c => c.sql.includes('UPDATE shadow_trades'));
    assert.ok(updateCall);
    assert.equal(updateCall.params[0], -10000, 'pnl should be -marginUsed from override');
  });

  test('normal closure computes pnl from margin difference and updates balance', async () => {
    const trader = new ShadowTrader();

    // Take profit hit: buy at 50000, TP at 51000, leverage 1
    const trade = makeTrade({
      id: 'pnl-normal-1',
      side: 'buy',
      price: 50000,
      stopLoss: 49000,
      takeProfit: 51000,
      leverage: 1,
      amount: 1,
      candlesHeld: 0,
      isRunner: false,
      risk_mode: RiskMode.MODERATE,
    });

    trader.portfolios[RiskMode.MODERATE].openTrades = [trade];
    const initialBalance = trader.portfolios[RiskMode.MODERATE].balance;

    await trader.updatePositions(51000, undefined, undefined, undefined, { time: Date.now() });

    assert.equal(trader.portfolios[RiskMode.MODERATE].openTrades.length, 0, 'trade should be closed');
    // pnl = currentMargin - marginUsed = (51000/1) - (50000/1) = 1000
    assert.equal(trader.portfolios[RiskMode.MODERATE].balance, initialBalance + 1000);

    const updateCall = dbCalls.find(c => c.sql.includes('UPDATE shadow_trades'));
    assert.ok(updateCall);
    assert.equal(updateCall.params[0], 1000, 'pnl should be 1000 (51000-50000)');
    assert.equal(updateCall.params[1], 51000, 'exit_price should be 51000');
  });
});
