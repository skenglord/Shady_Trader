import { test } from 'node:test';
import assert from 'node:assert';
import { BalanceManager } from '../../backend/balance/manager.js';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';
import { RiskMode } from '../../backend/risk/manager.js';
import { runQuery, setMockRunQuery } from '../../backend/database.js';

const mockBalances = {
  main_balance: 100000,
  bot_balance: 0,
  active_trade_balance: 0
};

setMockRunQuery(async (sql, params = [], type = 'run') => {
  if (sql.includes('SELECT * FROM balances')) {
    return [{
      ...mockBalances,
      total_pnl: 0,
      total_pnl_pct: 0,
      updated_at: Date.now()
    }];
  }

  if (sql.includes('UPDATE balances')) {
    if (sql.includes('main_balance = ?, bot_balance = ?, active_trade_balance = ?')) {
      mockBalances.main_balance = Number(params[0]);
      mockBalances.bot_balance = Number(params[1]);
      mockBalances.active_trade_balance = Number(params[2]);
    } else if (sql.includes('main_balance = 100000, bot_balance = 0')) {
      mockBalances.main_balance = 100000;
      mockBalances.bot_balance = 0;
      mockBalances.active_trade_balance = 0;
    }
    return { changes: 1 };
  }

  if (sql.includes('DELETE FROM shadow_trades')) return { changes: 1 };
  if (sql.includes('INSERT INTO shadow_trades')) return { changes: 1 };

  if (type === 'all') return [];
  return { changes: 1 };
});

test('BalanceManager should move funds correctly', async () => {
  await runQuery('UPDATE balances SET main_balance = 100000, bot_balance = 0 WHERE id = ?', ['default']);
  
  const manager = new BalanceManager();
  const initial = await manager.getBalances();
  
  await manager.allocateToBot(1000);
  const afterAllocate = await manager.getBalances();
  assert.strictEqual(afterAllocate.botBalance, initial.botBalance + 1000);
  assert.strictEqual(afterAllocate.mainBalance, initial.mainBalance - 1000);
  
  await manager.withdrawFromBot(500);
  const afterWithdraw = await manager.getBalances();
  assert.strictEqual(afterWithdraw.botBalance, afterAllocate.botBalance - 500);
  assert.strictEqual(afterWithdraw.mainBalance, afterAllocate.mainBalance + 500);
});

test('ShadowTrader should move funds when opening trade', async () => {
    const manager = new BalanceManager();
    await manager.updateBalances({ mainBalance: 100000, botBalance: 5000, activeTradeBalance: 0 });

    const trader = new ShadowTrader();
    trader.portfolios[RiskMode.MODERATE].initialBalance = 5000;
    trader.portfolios[RiskMode.MODERATE].balance = 5000;
    await trader.reset();
    trader.portfolios[RiskMode.MODERATE].initialBalance = 5000;
    trader.portfolios[RiskMode.MODERATE].balance = 5000;
    
    const signal = {
        symbol: 'BTC/USDT',
        side: 'buy',
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 51000
    };
    
    const initialBalances = await manager.getBalances();
    await trader.reset();
    trader.portfolios[RiskMode.MODERATE].initialBalance = 5000;
    trader.portfolios[RiskMode.MODERATE].balance = 5000;
    await trader.processSignal({ ...signal, confidence: 90 }, 50000, RiskMode.MODERATE, manager, null, 'strongbull');
    
    const afterBalances = await manager.getBalances();
    assert.ok(afterBalances.botBalance < initialBalances.botBalance); // Funds moved into active trade bucket
    assert.ok(afterBalances.activeTradeBalance > 0);
});
