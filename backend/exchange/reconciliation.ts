import { createHash } from 'node:crypto';
import { runQuery } from '../database.js';
import { logger } from '../logging/logger.js';
import { BaseExchangeAdapter, PositionReconciliationUnavailableError } from './adapter.js';
import type { AccountExecutionAdapter, NormalizedExchangeFill, NormalizedExchangeOrder } from './account-execution-adapter.js';
import { applyExchangeFill } from './fill-settlement.js';
import { BalanceManager } from '../balance/manager.js';

export interface ReconciliationResult { exchange: string; accountId: string; ready: boolean; ordersRead: number; fillsRead: number; applied: number; duplicates: number; unresolved: number; checkpoint: number; }
export interface ReconciliationScope { exchange: string; accountId: string; }
type IncidentStatus = 'open' | 'resolved';

export class PositionReconciliationEngine {
  private adapters = new Map<string, AccountExecutionAdapter>();
  private legacyAdapters = new Map<string, BaseExchangeAdapter>();
  private queues = new Map<string, Promise<unknown>>();
  private reconciliationInterval: NodeJS.Timeout | null = null;

  registerAdapter(adapter: AccountExecutionAdapter): void;
  /** @deprecated compatibility for historical position-only callers */
  registerAdapter(exchangeName: string, adapter: BaseExchangeAdapter): void;
  registerAdapter(adapterOrName: AccountExecutionAdapter | string, legacy?: BaseExchangeAdapter): void {
    if (typeof adapterOrName === 'string') {
      if (legacy) this.legacyAdapters.set(adapterOrName, legacy);
      return;
    }
    this.adapters.set(this.key(adapterOrName), adapterOrName);
  }

  startReconciliation(intervalMs = 30_000) {
    if (this.reconciliationInterval) return;
    this.reconciliationInterval = setInterval(() => {
      for (const adapter of this.adapters.values()) void this.reconcileAccount(adapter).catch(error => logger.error('Account reconciliation failed', { exchange: adapter.exchange, accountId: adapter.accountId, error: error instanceof Error ? error.message : String(error) }));
      void this.performLegacyReconciliation();
    }, intervalMs);
    this.reconciliationInterval.unref?.();
  }

  stopReconciliation() { if (this.reconciliationInterval) clearInterval(this.reconciliationInterval); this.reconciliationInterval = null; }

  async reconcileAccount(adapter: AccountExecutionAdapter): Promise<ReconciliationResult> {
    const key = this.key(adapter);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      try { return await this.runAccountCycle(adapter); }
      catch (error) {
        const scope = { exchange: adapter.exchange, accountId: adapter.accountId };
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        await runQuery(`INSERT INTO exchange_reconciliation_state (exchange_name, account_id, status, fill_cursor, last_checked_at, last_error) VALUES (?, ?, 'blocked', NULL, ?, ?) ON CONFLICT(exchange_name, account_id) DO UPDATE SET status = 'blocked', last_checked_at = excluded.last_checked_at, last_error = excluded.last_error`, [scope.exchange, scope.accountId, Date.now(), message]);
        throw error;
      }
    });
    this.queues.set(key, current);
    try { return await current; } finally { if (this.queues.get(key) === current) this.queues.delete(key); }
  }

  private async runAccountCycle(adapter: AccountExecutionAdapter): Promise<ReconciliationResult> {
    const scope = { exchange: adapter.exchange, accountId: adapter.accountId };
    if (!adapter.capabilities.supportsAuthenticatedReads || !adapter.capabilities.supportsClientOrderIds) throw new Error('Account adapter lacks required recovery capabilities');
    const states = await runQuery(`SELECT fill_cursor FROM exchange_reconciliation_state WHERE exchange_name = ? AND account_id = ?`, [scope.exchange, scope.accountId], 'all');
    const oldCheckpoint = Math.max(0, Number(states[0]?.fill_cursor || 0));
    const from = Math.max(0, oldCheckpoint - 120_000);
    // Gather every page before applying or checkpointing; a later page failure leaves the cursor untouched.
    const openOrders = await this.retryRead(() => adapter.listOpenOrders());
    const orders = await this.readAllOrders(adapter, from);
    const fills = await this.readAllFills(adapter, from);
    const intents = await runQuery(`SELECT ei.*, COALESCE(ei.requested_quantity, st.amount) AS request_quantity FROM execution_intents ei LEFT JOIN shadow_trades st ON st.id = ei.trade_id WHERE ei.exchange_name = ? AND ei.account_id = ? AND ei.status IN ('pending','submitted','uncertain','partially_filled')`, [scope.exchange, scope.accountId], 'all');
    const observedOrders = [...new Map([...openOrders, ...orders].map(order => [order.exchangeOrderId, order])).values()];
    const orderById = new Map(observedOrders.map(order => [order.exchangeOrderId, order]));
    const orderByClient = new Map<string, NormalizedExchangeOrder[]>();
    for (const order of observedOrders) if (order.clientOrderId) orderByClient.set(order.clientOrderId, [...(orderByClient.get(order.clientOrderId) || []), order]);
    const matchedIds = new Set<string>();
    for (const intent of intents) {
      let match = intent.exchange_order_id ? orderById.get(String(intent.exchange_order_id)) : undefined;
      if (!match && intent.client_order_id) {
        const byClient = orderByClient.get(String(intent.client_order_id)) || [];
        if (byClient.length === 1) match = byClient[0];
      }
      if (!match && !intent.exchange_order_id && !intent.client_order_id) {
        const candidates = observedOrders.filter(order => order.symbol === intent.symbol && order.side === intent.side && Math.abs(order.requestedQuantity - Number(intent.request_quantity || -1)) < 1e-8 && Math.abs(order.updatedAt - Number(intent.created_at)) < 5 * 60_000);
        if (candidates.length === 1) match = candidates[0];
        else await this.recordIncident(scope, candidates.length ? 'ambiguous_legacy_order' : 'unmatched_intent', { intentKey: intent.idempotency_key, candidateOrderIds: candidates.map(item => item.exchangeOrderId) });
      }
      if (match) {
        matchedIds.add(match.exchangeOrderId);
        if (match.clientOrderId) matchedIds.add(match.clientOrderId);
        await runQuery(`UPDATE execution_intents SET exchange_order_id = ?, last_observed_at = ?, status = CASE WHEN status IN ('pending','uncertain') THEN 'submitted' ELSE status END WHERE idempotency_key = ?`, [match.exchangeOrderId, match.updatedAt, intent.idempotency_key]);
      }
      else if (intent.exchange_order_id || intent.client_order_id) await this.recordIncident(scope, 'intent_order_missing', { intentKey: intent.idempotency_key, exchangeOrderId: intent.exchange_order_id, clientOrderId: intent.client_order_id });
    }
    const knownOrders = new Set(intents.flatMap((intent: any) => [intent.exchange_order_id, intent.client_order_id]).filter(Boolean).map(String));
    for (const id of matchedIds) knownOrders.add(id);
    for (const order of observedOrders.filter(order => order.status === 'open' || order.status === 'partially_filled' || order.status === 'pending')) {
      if (!knownOrders.has(order.exchangeOrderId) && (!order.clientOrderId || !knownOrders.has(order.clientOrderId))) await this.recordIncident(scope, 'external_order', { orderId: order.exchangeOrderId, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, quantity: order.requestedQuantity });
    }
    let applied = 0, duplicates = 0;
    for (const fill of fills.sort((a, b) => a.timestamp - b.timestamp)) {
      const quoteCurrency = fill.symbol.split('/')[1];
      if (fill.fee > 0 && (!fill.feeCurrency || fill.feeCurrency !== quoteCurrency)) {
        await this.recordIncident(scope, 'unvalued_fill_fee', { orderId: fill.exchangeOrderId, fillId: fill.exchangeFillId, fee: fill.fee, feeCurrency: fill.feeCurrency, quoteCurrency });
        continue;
      }
      const result = await applyExchangeFill(fill, scope, new BalanceManager());
      if (result === 'applied') applied++;
      else if (result === 'duplicate') duplicates++;
      else await this.recordIncident(scope, 'unmatched_fill', { orderId: fill.exchangeOrderId, fillId: fill.exchangeFillId, clientOrderId: fill.clientOrderId, symbol: fill.symbol, side: fill.side, quantity: fill.quantity, price: fill.price });
    }
    const checkpoint = fills.reduce((max, fill) => Math.max(max, fill.timestamp), oldCheckpoint);
    const unresolved = await this.hasUnresolvedIncidents(scope);
    await runQuery(`INSERT INTO exchange_reconciliation_state (exchange_name, account_id, status, fill_cursor, last_checked_at, last_successful_at, last_error) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(exchange_name, account_id) DO UPDATE SET status = excluded.status, fill_cursor = excluded.fill_cursor, last_checked_at = excluded.last_checked_at, last_successful_at = excluded.last_successful_at, last_error = NULL`, [scope.exchange, scope.accountId, unresolved ? 'blocked' : 'ready', String(checkpoint), Date.now(), Date.now()]);
    return { ...scope, ready: !unresolved, ordersRead: orders.length + openOrders.length, fillsRead: fills.length, applied, duplicates, unresolved: (await this.listIncidents(scope, 'open')).length, checkpoint };
  }

  private async readAllOrders(adapter: AccountExecutionAdapter, since: number) { return this.readPages(cursor => this.retryRead(() => adapter.listOrders(since, cursor))); }
  private async readAllFills(adapter: AccountExecutionAdapter, since: number) { return this.readPages(cursor => this.retryRead(() => adapter.listFills(since, cursor))); }
  private async retryRead<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await read(); }
      catch (error: any) {
        const transient = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'].includes(error?.code) || error?.response?.status === 429 || error?.response?.status >= 500;
        if (!transient || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  private async readPages<T>(fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
    const all: T[] = []; let cursor: string | undefined; const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result = await fetch(cursor);
      if (!result || !Array.isArray(result.items) || !Object.prototype.hasOwnProperty.call(result, 'nextCursor')) throw new Error('Malformed or incomplete exchange page');
      all.push(...result.items);
      if (!result.nextCursor) return all;
      if (seen.has(result.nextCursor)) throw new Error('Exchange pagination cursor repeated; snapshot is incomplete');
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('Exchange pagination exceeded safety limit; snapshot is incomplete');
  }

  private async recordIncident(scope: ReconciliationScope, type: string, evidence: unknown) {
    const json = JSON.stringify(evidence);
    const id = createHash('sha256').update(`${scope.exchange}:${scope.accountId}:${type}:${json}`).digest('hex');
    const now = Date.now();
    await runQuery(`INSERT INTO exchange_reconciliation_incidents (id, exchange_name, account_id, incident_type, evidence_json, status, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`, [id, scope.exchange, scope.accountId, type, json, now, now]);
  }

  async listIncidents(scope?: ReconciliationScope, status?: IncidentStatus): Promise<any[]> {
    let sql = 'SELECT * FROM exchange_reconciliation_incidents WHERE 1=1'; const params: any[] = [];
    if (scope) { sql += ' AND exchange_name = ? AND account_id = ?'; params.push(scope.exchange, scope.accountId); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY opened_at DESC'; return runQuery(sql, params, 'all');
  }
  async resolveIncident(id: string, actor: string, reason: string): Promise<void> {
    if (!actor?.trim() || !reason?.trim()) throw new Error('Incident resolution requires actor and reason');
    const result = await runQuery(`UPDATE exchange_reconciliation_incidents SET status = 'resolved', resolved_at = ?, updated_at = ?, resolved_by = ?, resolution_reason = ? WHERE id = ? AND status = 'open'`, [Date.now(), Date.now(), actor.trim(), reason.trim(), id]);
    if (result?.changes === 0 || result?.rowCount === 0) throw new Error('Open reconciliation incident not found');
  }
  async hasUnresolvedIncidents(scope: ReconciliationScope): Promise<boolean> { const rows = await this.listIncidents(scope, 'open'); return rows.length > 0; }
  async getAccountReadiness(scope: ReconciliationScope): Promise<boolean> {
    const rows = await runQuery(`SELECT status, last_successful_at FROM exchange_reconciliation_state WHERE exchange_name = ? AND account_id = ?`, [scope.exchange, scope.accountId], 'all');
    const successfulAt = Number(rows[0]?.last_successful_at || 0);
    const fresh = successfulAt > 0 && Date.now() - successfulAt <= 90_000;
    return rows[0]?.status === 'ready' && fresh && !(await this.hasUnresolvedIncidents(scope));
  }

  /** Backward-compatible read-only history used by the existing admin views. */
  async getReconciliationHistory(exchangeName?: string, limit = 100): Promise<any[]> {
    const sql = `SELECT * FROM order_reconciliation_log ${exchangeName ? 'WHERE exchange_name = ?' : ''} ORDER BY timestamp DESC LIMIT ?`;
    return runQuery(sql, exchangeName ? [exchangeName, limit] : [limit], 'all');
  }
  private key(adapter: AccountExecutionAdapter) { return `${adapter.exchange}:${adapter.accountId}`; }
  private async performLegacyReconciliation() {
    for (const [exchange, adapter] of this.legacyAdapters) {
      try { await adapter.getPositions(); }
      catch (error) {
        logger.error(error instanceof PositionReconciliationUnavailableError ? 'Exchange position reconciliation unavailable; no empty snapshot will be assumed' : 'Failed to reconcile positions for exchange', { exchange, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  private async performReconciliation() { await this.performLegacyReconciliation(); }
}
