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
  if (fill.fee > 0 && fill.feeCurrency !== fill.symbol.split('/')[1]) return 'unmatched';
  return withDatabaseTransaction(async query => {
    const intents = await query(`
      SELECT * FROM execution_intents
      WHERE exchange_name = ? AND account_id = ?
        AND ((exchange_order_id IS NOT NULL AND exchange_order_id = ?) OR (client_order_id IS NOT NULL AND client_order_id = ?))
      ORDER BY created_at DESC LIMIT 2
      ${process.env.USE_POSTGRES === 'true' ? 'FOR UPDATE' : ''}
    `, [scope.exchange, scope.accountId, fill.exchangeOrderId, fill.clientOrderId || ''], 'all');
    if (!intents.length || intents.length !== 1) return 'unmatched';
    const intent = intents[0];
    const intentSide = String(intent.side).toLowerCase();
    const alreadyFilled = Number(intent.filled_quantity || 0);
    const requested = Number(intent.requested_quantity || 0);
    const tolerance = Math.max(1e-10, requested * 1e-8);
    if ((intent.exchange_order_id && String(intent.exchange_order_id) !== fill.exchangeOrderId)
      || (intent.client_order_id && fill.clientOrderId && String(intent.client_order_id) !== fill.clientOrderId)
      || String(intent.symbol).replace('-', '/').toUpperCase() !== fill.symbol.replace('-', '/').toUpperCase()
      || intentSide !== fill.side) return 'unmatched';
    const existing = await query(`SELECT 1 FROM exchange_fills WHERE exchange_name = ? AND account_id = ? AND exchange_order_id = ? AND exchange_fill_id = ?`, [scope.exchange, scope.accountId, fill.exchangeOrderId, fill.exchangeFillId], 'all');
    if (existing.length) return 'duplicate';
    if (!Number.isFinite(requested) || requested <= 0 || alreadyFilled + fill.quantity > requested + tolerance) return 'unmatched';

    await query(`INSERT INTO exchange_fills (exchange_name, account_id, exchange_order_id, exchange_fill_id, idempotency_key, trade_id, symbol, side, quantity, price, fee, fee_currency, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [scope.exchange, scope.accountId, fill.exchangeOrderId, fill.exchangeFillId, intent.idempotency_key, intent.trade_id, fill.symbol, fill.side, fill.quantity, fill.price, fill.fee, fill.feeCurrency, fill.timestamp]);
    const now = Date.now();
    const totalFilled = Number(intent.filled_quantity || 0) + fill.quantity;
    const newAverage = ((Number(intent.average_fill_price || 0) * Number(intent.filled_quantity || 0)) + fill.price * fill.quantity) / totalFilled;
    const intentStatus = totalFilled + 1e-12 >= Number(intent.requested_quantity || Infinity) ? 'complete' : 'partially_filled';
    await query(`UPDATE execution_intents SET filled_quantity = ?, average_fill_price = ?, last_observed_at = ?, status = ? WHERE idempotency_key = ?`, [totalFilled, newAverage, now, intentStatus, intent.idempotency_key]);

    if (intent.intent_type === 'exit') {
      const tradeId = intent.parent_trade_id || String(intent.trade_id).replace(/:close$/, '');
      const rows = await query(`SELECT * FROM shadow_trades WHERE id = ? AND exchange_name = ? AND account_id = ? ${process.env.USE_POSTGRES === 'true' ? 'FOR UPDATE' : ''}`, [tradeId, scope.exchange, scope.accountId], 'all');
      if (!rows.length) throw new Error('Matched exit fill has no scoped trade');
      const trade = rows[0];
      const remaining = Number(trade.remaining_amount ?? trade.amount);
      if (fill.quantity > remaining + 1e-10) throw new Error('Exit fill exceeds remaining trade quantity');
      const nextRemaining = Math.max(0, remaining - fill.quantity);
      const grossPnl = String(trade.side).toLowerCase() === 'buy' ? (fill.price - Number(trade.price)) * fill.quantity : (Number(trade.price) - fill.price) * fill.quantity;
      const quoteCurrency = fill.symbol.split('/')[1];
      const fee = fill.feeCurrency === quoteCurrency ? fill.fee : 0;
      const realizedPnl = grossPnl - fee;
      const cumulativePnl = Number(trade.realized_pnl || 0) + realizedPnl;
      await query(`UPDATE shadow_trades SET remaining_amount = ?, realized_pnl = ?, status = ?, pnl = CASE WHEN ? = 0 THEN ? ELSE pnl END, exit_price = CASE WHEN ? = 0 THEN ? ELSE exit_price END, exit_timestamp = CASE WHEN ? = 0 THEN ? ELSE exit_timestamp END WHERE id = ?`, [nextRemaining, cumulativePnl, nextRemaining === 0 ? 'closed' : 'open', nextRemaining, cumulativePnl, nextRemaining, fill.price, nextRemaining, fill.timestamp, tradeId]);
      // This adapter is spot-only: principal reserved on entry is full notional,
      // regardless of a strategy's simulated leverage setting.
      await balanceManager.recordTradeResultInTransaction(query, realizedPnl, Number(trade.price) * fill.quantity, { exchange: scope.exchange, accountId: scope.accountId, exchangeFillId: fill.exchangeFillId });
    } else {
      const rows = await query(`SELECT * FROM shadow_trades WHERE id = ? AND exchange_name = ? AND account_id = ? ${process.env.USE_POSTGRES === 'true' ? 'FOR UPDATE' : ''}`, [intent.trade_id, scope.exchange, scope.accountId], 'all');
      if (!rows.length) throw new Error('Matched entry fill has no scoped trade');
      const trade = rows[0];
      const prior = Number(trade.remaining_amount ?? 0);
      const priorNotional = prior * Number(trade.price || 0);
      const quantity = prior + fill.quantity;
      const quoteCurrency = fill.symbol.split('/')[1];
      const fee = fill.feeCurrency === quoteCurrency ? fill.fee : 0;
      const averagePrice = (priorNotional + fill.quantity * fill.price + fee) / quantity;
      await query(`UPDATE shadow_trades SET amount = ?, remaining_amount = ?, price = ?, status = 'open' WHERE id = ?`, [quantity, quantity, averagePrice, intent.trade_id]);
      await balanceManager.addActiveTradeInTransaction(query, fill.quantity * fill.price + fee, { exchange: scope.exchange, accountId: scope.accountId, exchangeFillId: fill.exchangeFillId });
    }
    return 'applied';
  });
}
