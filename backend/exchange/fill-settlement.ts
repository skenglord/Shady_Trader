import { withDatabaseTransaction, type TransactionQuery } from '../database.js';
import type { NormalizedExchangeFill } from './account-execution-adapter.js';
import type { BalanceManager } from '../balance/manager.js';

export type ExchangeScope = { exchange: string; accountId: string };

/** Apply one authoritative fill once, in the same transaction as its accounting effects. */
export async function applyExchangeFill(
  fill: NormalizedExchangeFill,
  scope: ExchangeScope,
  balanceManager: BalanceManager
): Promise<'applied' | 'duplicate' | 'unmatched'> {
  return withDatabaseTransaction(async query => {
    const intents = await query(`
      SELECT * FROM execution_intents
      WHERE exchange_name = ? AND account_id = ?
        AND ((exchange_order_id IS NOT NULL AND exchange_order_id = ?) OR (client_order_id IS NOT NULL AND client_order_id = ?))
      ORDER BY created_at DESC LIMIT 2
    `, [scope.exchange, scope.accountId, fill.exchangeOrderId, fill.clientOrderId || ''], 'all');
    if (!intents.length || intents.length !== 1) return 'unmatched';
    const intent = intents[0];
    const existing = await query(`SELECT 1 FROM exchange_fills WHERE exchange_name = ? AND account_id = ? AND exchange_order_id = ? AND exchange_fill_id = ?`, [scope.exchange, scope.accountId, fill.exchangeOrderId, fill.exchangeFillId], 'all');
    if (existing.length) return 'duplicate';

    await query(`INSERT INTO exchange_fills (exchange_name, account_id, exchange_order_id, exchange_fill_id, idempotency_key, trade_id, symbol, side, quantity, price, fee, fee_currency, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [scope.exchange, scope.accountId, fill.exchangeOrderId, fill.exchangeFillId, intent.idempotency_key, intent.trade_id, fill.symbol, fill.side, fill.quantity, fill.price, fill.fee, fill.feeCurrency, fill.timestamp]);
    const now = Date.now();
    const totalFilled = Number(intent.filled_quantity || 0) + fill.quantity;
    const newAverage = ((Number(intent.average_fill_price || 0) * Number(intent.filled_quantity || 0)) + fill.price * fill.quantity) / totalFilled;
    const intentStatus = totalFilled + 1e-12 >= Number(intent.requested_quantity || Infinity) ? 'complete' : 'partially_filled';
    await query(`UPDATE execution_intents SET filled_quantity = ?, average_fill_price = ?, last_observed_at = ?, status = ? WHERE idempotency_key = ?`, [totalFilled, newAverage, now, intentStatus, intent.idempotency_key]);

    if (intent.intent_type === 'exit') {
      const tradeId = intent.parent_trade_id || String(intent.trade_id).replace(/:close$/, '');
      const rows = await query(`SELECT * FROM shadow_trades WHERE id = ? AND exchange_name = ? AND account_id = ?`, [tradeId, scope.exchange, scope.accountId], 'all');
      if (!rows.length) throw new Error('Matched exit fill has no scoped trade');
      const trade = rows[0];
      const remaining = Number(trade.remaining_amount ?? trade.amount);
      if (fill.quantity > remaining + 1e-10) throw new Error('Exit fill exceeds remaining trade quantity');
      const nextRemaining = Math.max(0, remaining - fill.quantity);
      const grossPnl = String(trade.side).toLowerCase() === 'buy' ? (fill.price - Number(trade.price)) * fill.quantity : (Number(trade.price) - fill.price) * fill.quantity;
      const fee = fill.feeCurrency && /^(USD|USDT|USDC|EUR|GBP)$/.test(fill.feeCurrency) ? fill.fee : 0;
      const realizedPnl = grossPnl - fee;
      const cumulativePnl = Number(trade.realized_pnl || 0) + realizedPnl;
      await query(`UPDATE shadow_trades SET remaining_amount = ?, realized_pnl = ?, status = ?, pnl = CASE WHEN ? = 0 THEN ? ELSE pnl END, exit_price = CASE WHEN ? = 0 THEN ? ELSE exit_price END, exit_timestamp = CASE WHEN ? = 0 THEN ? ELSE exit_timestamp END WHERE id = ?`, [nextRemaining, cumulativePnl, nextRemaining === 0 ? 'closed' : 'open', nextRemaining, cumulativePnl, nextRemaining, fill.price, nextRemaining, fill.timestamp, tradeId]);
      await balanceManager.recordTradeResultInTransaction(query, realizedPnl, Number(trade.price) * fill.quantity / Math.max(1, Number(trade.leverage || 1)), { exchange: scope.exchange, accountId: scope.accountId, exchangeFillId: fill.exchangeFillId });
    } else {
      const rows = await query(`SELECT * FROM shadow_trades WHERE id = ? AND exchange_name = ? AND account_id = ?`, [intent.trade_id, scope.exchange, scope.accountId], 'all');
      if (!rows.length) throw new Error('Matched entry fill has no scoped trade');
      const trade = rows[0];
      const prior = Number(trade.remaining_amount ?? 0);
      const priorNotional = prior * Number(trade.price || 0);
      const quantity = prior + fill.quantity;
      const averagePrice = (priorNotional + fill.quantity * fill.price) / quantity;
      await query(`UPDATE shadow_trades SET amount = ?, remaining_amount = ?, price = ?, status = 'open' WHERE id = ?`, [quantity, quantity, averagePrice, intent.trade_id]);
    }
    return 'applied';
  });
}
