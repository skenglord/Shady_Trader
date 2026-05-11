import { runQuery } from '../database.js';
import { logger } from '../logging/logger.js';
import { BaseExchangeAdapter } from './adapter.js';

export interface PositionReconciliation {
  symbol: string;
  localQuantity: number;
  exchangeQuantity: number;
  discrepancy: number;
  timestamp: number;
  resolved: boolean;
  resolutionAction?: string;
}

export class PositionReconciliationEngine {
  private exchangeAdapters: Map<string, BaseExchangeAdapter> = new Map();
  private reconciliationInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  registerAdapter(exchangeName: string, adapter: BaseExchangeAdapter) {
    this.exchangeAdapters.set(exchangeName, adapter);
  }

  startReconciliation(intervalMs: number = 30000) {
    if (this.isRunning) return;

    this.isRunning = true;
    this.reconciliationInterval = setInterval(async () => {
      try {
        await this.performReconciliation();
      } catch (error) {
        logger.error('Reconciliation cycle failed', { error: error.message });
      }
    }, intervalMs);

    logger.info('Position reconciliation engine started', { intervalMs });
  }

  stopReconciliation() {
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }
    this.isRunning = false;
    logger.info('Position reconciliation engine stopped');
  }

  private async performReconciliation() {
    const exchanges = Array.from(this.exchangeAdapters.keys());

    for (const exchangeName of exchanges) {
      try {
        await this.reconcileExchangePositions(exchangeName);
      } catch (error) {
        logger.error('Failed to reconcile positions for exchange', {
          exchange: exchangeName,
          error: error.message
        });
      }
    }
  }

  private async reconcileExchangePositions(exchangeName: string) {
    const adapter = this.exchangeAdapters.get(exchangeName);
    if (!adapter) return;

    // Get exchange positions
    const exchangePositions = await adapter.getPositions();

    // Get local shadow positions for this exchange
    const localPositions = await this.getLocalPositions(exchangeName);

    // Compare positions
    const reconciliationResults: PositionReconciliation[] = [];

    // Check all symbols that have positions in either local or exchange
    const allSymbols = new Set([
      ...exchangePositions.map(p => p.symbol),
      ...localPositions.map(p => p.symbol)
    ]);

    for (const symbol of allSymbols) {
      const exchangePos = exchangePositions.find(p => p.symbol === symbol);
      const localPos = localPositions.find(p => p.symbol === symbol);

      const exchangeQty = exchangePos?.quantity || 0;
      const localQty = localPos?.quantity || 0;
      const discrepancy = Math.abs(exchangeQty - localQty);

      if (discrepancy > 0.001) { // Allow for small floating point differences
        const reconciliation: PositionReconciliation = {
          symbol,
          localQuantity: localQty,
          exchangeQuantity: exchangeQty,
          discrepancy,
          timestamp: Date.now(),
          resolved: false
        };

        reconciliationResults.push(reconciliation);

        // Attempt auto-resolution
        await this.attemptAutoResolution(exchangeName, reconciliation, adapter);
      }
    }

    // Log reconciliation results
    if (reconciliationResults.length > 0) {
      await this.logReconciliationResults(exchangeName, reconciliationResults);
    }
  }

  private async getLocalPositions(exchangeName: string): Promise<any[]> {
    // Query shadow_trades for open positions on this exchange
    const rows = await runQuery(`
      SELECT symbol, SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) as net_quantity
      FROM shadow_trades
      WHERE status = 'open' AND exchange = ?
      GROUP BY symbol
      HAVING net_quantity != 0
    `, [exchangeName], 'all');

    return rows.map(row => ({
      symbol: row.symbol,
      quantity: row.net_quantity
    }));
  }

  private async attemptAutoResolution(
    exchangeName: string,
    reconciliation: PositionReconciliation,
    adapter: BaseExchangeAdapter
  ) {
    try {
      if (Math.abs(reconciliation.discrepancy) > 0.01) { // Significant discrepancy
        // Close the phantom position on exchange if local shows zero
        if (reconciliation.localQuantity === 0 && Math.abs(reconciliation.exchangeQuantity) > 0) {
          logger.warn('Detected ghost position on exchange, attempting to close', {
            exchange: exchangeName,
            symbol: reconciliation.symbol,
            quantity: reconciliation.exchangeQuantity
          });

          // Place market order to close position
          const side = reconciliation.exchangeQuantity > 0 ? 'sell' : 'buy';
          const quantity = Math.abs(reconciliation.exchangeQuantity);

          await adapter.placeOrder({
            symbol: reconciliation.symbol,
            side,
            type: 'market',
            quantity
          });

          reconciliation.resolved = true;
          reconciliation.resolutionAction = `Closed ghost position: ${side} ${quantity}`;
        }
        // If exchange shows zero but local shows position, this is a sync issue
        else if (reconciliation.exchangeQuantity === 0 && Math.abs(reconciliation.localQuantity) > 0) {
          logger.warn('Detected missing position on exchange', {
            exchange: exchangeName,
            symbol: reconciliation.symbol,
            localQuantity: reconciliation.localQuantity
          });

          // This requires manual intervention - log for review
          reconciliation.resolutionAction = 'Manual review required - position missing on exchange';
        }
      } else {
        // Small discrepancy, likely rounding error - mark as resolved
        reconciliation.resolved = true;
        reconciliation.resolutionAction = 'Small discrepancy resolved (rounding error)';
      }
    } catch (error) {
      logger.error('Auto-resolution failed', {
        exchange: exchangeName,
        symbol: reconciliation.symbol,
        error: error.message
      });
      reconciliation.resolutionAction = `Auto-resolution failed: ${error.message}`;
    }
  }

  private async logReconciliationResults(exchangeName: string, results: PositionReconciliation[]) {
    const timestamp = Date.now();

    for (const result of results) {
      await runQuery(`
        INSERT INTO order_reconciliation_log
        (exchange_name, symbol, local_quantity, exchange_quantity, discrepancy, resolved, resolution_action, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        exchangeName,
        result.symbol,
        result.localQuantity,
        result.exchangeQuantity,
        result.discrepancy,
        result.resolved,
        result.resolutionAction || null,
        timestamp
      ]);
    }

    const unresolvedCount = results.filter(r => !r.resolved).length;
    if (unresolvedCount > 0) {
      logger.warn('Position reconciliation completed with unresolved discrepancies', {
        exchange: exchangeName,
        totalDiscrepancies: results.length,
        unresolvedCount
      });
    } else {
      logger.info('Position reconciliation completed successfully', {
        exchange: exchangeName,
        checkedPositions: results.length
      });
    }
  }

  async getReconciliationHistory(exchangeName?: string, limit: number = 100): Promise<any[]> {
    let query = `
      SELECT * FROM order_reconciliation_log
      WHERE 1=1
    `;
    const params: any[] = [];

    if (exchangeName) {
      query += ' AND exchange_name = ?';
      params.push(exchangeName);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    return await runQuery(query, params, 'all');
  }
}