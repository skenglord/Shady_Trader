import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMockRunQuery, setMockRunQuery } from '../../backend/database.js';
import {
  BinanceAdapter, CoinbaseAdapter, KrakenAdapter, OkxAdapter,
  PositionReconciliationUnavailableError,
} from '../../backend/exchange/adapter.js';
import { PositionReconciliationEngine } from '../../backend/exchange/reconciliation.js';

afterEach(() => clearMockRunQuery());

describe('exchange reconciliation fail-closed behavior', () => {
  test('adapters reject rather than report stubbed empty account positions', async () => {
    const adapters = [
      new BinanceAdapter('key', 'secret'),
      new KrakenAdapter('key', 'secret'),
      new OkxAdapter('key', 'secret', 'passphrase'),
      new CoinbaseAdapter('key', 'secret', 'passphrase'),
    ];
    for (const adapter of adapters) {
      await assert.rejects(adapter.getPositions(), PositionReconciliationUnavailableError);
    }
  });

  test('does not compare local positions or record zero-position mismatches without an exchange snapshot', async () => {
    const queries: string[] = [];
    setMockRunQuery(async (sql: string) => {
      queries.push(sql);
      return [];
    });
    const engine = new PositionReconciliationEngine();
    engine.registerAdapter('binance', {
      getPositions: async () => { throw new PositionReconciliationUnavailableError('binance'); },
    } as any);

    await (engine as any).performReconciliation();

    assert.deepEqual(queries, [], 'unavailable account state must not be treated as zero exposure');
  });
});
