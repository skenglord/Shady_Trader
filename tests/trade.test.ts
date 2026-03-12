import { test } from 'node:test';
import assert from 'node:assert';
import { BalanceManager } from '../backend/balance/manager.js';
import { ShadowTrader } from '../backend/shadow/shadow_trader.js';
import { RiskMode } from '../backend/risk/manager.js';
import { runQuery } from '../backend/database.js';

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
    await manager.updateBalances({ mainBalance: 100000, botBalance: 0, activeTradeBalance: 0 });

    const trader = new ShadowTrader();
    await trader.reset();
    
    const signal = {
        symbol: 'BTC/USDT',
        side: 'buy',
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 51000
    };
    
    const initialBalances = await manager.getBalances();
    await trader.reset();
    await trader.processSignal(signal, 50000, RiskMode.MODERATE, manager, null);
    
    const afterBalances = await manager.getBalances();
    assert.ok(afterBalances.botBalance > initialBalances.botBalance); // Should have allocated
    assert.ok(afterBalances.activeTradeBalance > 0);
});
