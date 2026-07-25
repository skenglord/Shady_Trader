/**
 * T8: Full-system integration coverage.
 *
 * Replaces the quarantined legacy suite (formerly skip-wrapped)
 * with a DETERMINISTIC, NETWORK-FREE integration test suite under node:test.
 *
 * Coverage areas:
 *  (a) Engine lifecycle — startTradingEngine / TradingEngine init + stop smoke
 *  (b) REST auth — requireRole middleware (admin/trader/public, fail-closed 503)
 *  (c) WebSocket auth — T3 first-message handshake (4401 timeout, auth_ok, broadcast)
 *  (d) Persistence round-trip — shadow trade INSERT then UPDATE close with pnl
 *
 * Determinism: NO live network. Exchange connector, CoinGecko, Ollama all stubbed.
 * ML_ENABLED=false, GEMMA_ENABLED=false, FREQTRADE_ENABLED=false.
 * Fixed seed data, no reliance on wall-clock candle timing.
 */

// ── Env flags MUST be set before any imports that read them at module load ──
process.env.ML_ENABLED = 'false';
process.env.GEMMA_ENABLED = 'false';
process.env.FREQTRADE_ENABLED = 'false';
process.env.USE_POSTGRES = 'false';
process.env.NODE_ENV = 'test';
// Short WS auth timeout so the unauthenticated-socket test resolves quickly.
// MUST be set before the dynamic import of backend/api/websocket.js below,
// because that module reads WS_AUTH_TIMEOUT_MS into a const at load time.
process.env.WS_AUTH_TIMEOUT_MS = '200';

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HttpServer } from 'http';

import { TradingEngine } from '../../backend/main.js';
import { MarketDataService } from '../../backend/api/marketDataService.js';
import { setMockRunQuery, clearMockRunQuery } from '../../backend/database.js';
import { apiRouter } from '../../backend/api/routes.js';
import { ShadowTrader } from '../../backend/shadow/shadow_trader.js';
import { RiskMode } from '../../backend/risk/manager.js';

// Dynamic import for setupWebsocket — ensures WS_AUTH_TIMEOUT_MS env var
// (set above) is read at module load time. With static imports, ESM hoisting
// would cause the module to load before the env assignment runs.
let setupWebsocket: (wss: WebSocketServer) => void;
before(async () => {
  const wsModule = await import('../../backend/api/websocket.js');
  setupWebsocket = wsModule.setupWebsocket;
});

// ── Test constants ──────────────────────────────────────────────────────────

const TEST_ADMIN_TOKEN = 'e2e-admin-token-do-not-use-in-prod';
const TEST_TRADER_TOKEN = 'e2e-trader-token-do-not-use-in-prod';

// Snapshot env for restoration in afterEach
const originalEnv = { ...process.env };

// ── Stub MarketDataService prototype methods (network-free) ─────────────────

MarketDataService.prototype.fetchMarketData = async () => ({
  market_cap: 0,
  total_volume: 0,
  fear_greed_index: 50,
  fear_greed_value: 'Neutral',
  btc_dominance: 0,
  last_updated: Date.now(),
  timestamp: Date.now(),
});
MarketDataService.prototype.fetchNews = async () => ([]);

// ── Network-freedom guard ───────────────────────────────────────────────────
//
// We monkey-patch globalThis.fetch to throw if any test attempts an outbound
// HTTP call. This is the strongest possible guarantee that no live network
// happens during the suite. (Routes.ts uses axios for CoinGecko, but that path
// is never reached because MarketDataService prototype methods are stubbed
// above and ML/freqtrade flags are disabled.)
//
// The guard is installed in before() and removed in after().

let originalFetch: typeof globalThis.fetch;

function installNetworkGuard() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('NETWORK GUARD: outbound fetch() blocked in integration test');
  }) as typeof globalThis.fetch;
}

function removeNetworkGuard() {
  globalThis.fetch = originalFetch;
}

// ── Redis mock ──────────────────────────────────────────────────────────────

function createRedisMock() {
  return {
    options: { host: 'mock', port: 6379 },
    status: 'ready',
    on: () => undefined,
    get: async () => null,
    set: async () => 'OK',
    setex: async () => 'OK',
    del: async () => 1,
    keys: async () => [],
    mget: async () => [],
    eval: async () => 'OK',
    publish: async () => 1,
    ping: async () => 'PONG',
    duplicate: () => ({
      subscribe: async () => undefined,
      on: () => undefined,
      unsubscribe: async () => undefined,
    }),
  };
}

// ── DB mock helpers ─────────────────────────────────────────────────────────

/**
 * Default mock that returns canned rows for common queries and { changes: 1 }
 * for writes. Used for engine lifecycle and REST auth tests.
 */
function setupDefaultDbMock() {
  setMockRunQuery(async (sql: string, _params: any[], type: 'run' | 'all') => {
    if (sql.includes('SELECT * FROM settings')) return [];
    if (sql.includes('SELECT 1')) return [{ 1: 1 }];
    if (sql.includes('SELECT * FROM balances')) {
      return [{ main_balance: 100000, bot_balance: 100000, active_trade_balance: 0, total_pnl: 0, total_pnl_pct: 0 }];
    }
    if (sql.includes('SELECT COUNT(*) as count')) return [{ count: 0 }];
    if (sql.includes('SELECT SUM(pnl) as totalPnl')) return [{ totalPnl: 0 }];
    if (sql.includes('SELECT exit_timestamp as time, pnl')) return [];
    if (sql.includes('FROM shadow_trades')) return [];
    if (sql.includes('FROM signals')) return [];
    if (sql.includes('FROM trades')) return [];
    if (sql.includes('FROM regime_history')) return [];
    if (sql.includes('FROM slippage_history')) return [];
    if (sql.includes('FROM candles')) return [];
    if (sql.includes('FROM market_data')) return [];
    if (sql.includes('FROM market_news')) return [];
    if (type === 'all') return [];
    return { changes: 1 };
  });
}

/**
 * Recording mock that captures SQL statements for the persistence round-trip
 * test. Returns { changes: 1 } for writes and [] for reads (except specific
 * canned responses).
 */
function createRecordingDbMock() {
  const recorded: { sql: string; params: any[]; type: string }[] = [];
  const mockFn = async (sql: string, params: any[] = [], type: 'run' | 'all' = 'run') => {
    recorded.push({ sql: sql.trim(), params, type });

    if (sql.includes('SELECT * FROM shadow_trades')) return [];
    if (sql.includes('SELECT SUM(pnl)')) return [{ totalPnl: 0 }];
    if (sql.includes('SELECT COUNT(*)')) return [{ count: 0 }];
    if (sql.includes('SELECT exit_timestamp')) return [];
    if (type === 'all') return [];
    return { changes: 1 };
  };
  return { mockFn, recorded };
}

// ── Fixed candle data for deterministic cycles ──────────────────────────────

function makeFixedCandles(count: number = 200): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const baseTime = 1700000000000; // fixed epoch
  const candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let price = 50000;
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random walk: no Math.random, just a fixed pattern
    const delta = ((i % 7) - 3) * 50;
    const open = price;
    const close = price + delta;
    const high = Math.max(open, close) + 25;
    const low = Math.min(open, close) - 25;
    candles.push({ time: baseTime + i * 900000, open, high, low, close, volume: 1000 });
    price = close;
  }
  return candles;
}

// ── Stub exchange connector ─────────────────────────────────────────────────

function createStubExchange() {
  const candles = makeFixedCandles(200);
  return {
    apiKey: '',
    exchangeName: 'coingecko' as const,
    testnet: true,
    getCandles: async (_symbol: string, _timeframe: string, _limit: number = 200) => candles,
    getHistoricalCandles: async (_symbol: string, _timeframe: string, _start: number, _limit: number, _end?: number) => candles,
    placeOrder: async () => ({ id: 'stub-order-1', status: 'filled', filled: 1, price: 50000, timestamp: Date.now(), simulated: true, exchange: 'coingecko' }),
    getBalance: async () => ({ USDT: 100000, BTC: 0, simulated: true }),
    cancelOrder: async () => true,
    setActiveSymbol: () => undefined,
    shutdown: () => undefined,
    providerRotator: { getSummary: () => [] },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═════════════════════════════════════════════════════════════════════════════

describe('Full-System Integration (T8)', { concurrency: false }, () => {

  before(() => {
    installNetworkGuard();
  });

  after(() => {
    removeNetworkGuard();
    clearMockRunQuery();
    // Restore env
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    clearMockRunQuery();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // (a) Engine lifecycle
  // ═════════════════════════════════════════════════════════════════════════

  describe('(a) Engine lifecycle', () => {

    test('TradingEngine initializes with mocked DB and stubbed exchange, stop() terminates cleanly', async () => {
      setupDefaultDbMock();

      const wss = new WebSocketServer({ noServer: true });
      const redisMock = createRedisMock();
      const engine = new TradingEngine(wss, redisMock as any);
      engine.isExchangeEnabled = false;
      await engine.init();

      // Engine should be initialized but not running
      assert.strictEqual(engine.isRunning, false);
      assert.ok(engine.shadowTrader, 'shadowTrader should be initialized');
      assert.ok(engine.balanceManager, 'balanceManager should be initialized');

      // Clean stop
      await engine.stop();
      assert.strictEqual(engine.isRunning, false);

      wss.close();
    });

    test('TradingEngine start() sets isRunning, stop() clears it', async () => {
      setupDefaultDbMock();

      const wss = new WebSocketServer({ noServer: true });
      const redisMock = createRedisMock();
      const engine = new TradingEngine(wss, redisMock as any);
      engine.isExchangeEnabled = false;

      // Stub the exchange with fixed candles so runCycle doesn't need network
      engine.exchange = createStubExchange() as any;

      await engine.init();

      // start() enters the run loop; we immediately stop to break the loop
      const startPromise = engine.start();
      // Let the event loop tick so isRunning is set
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(engine.isRunning, true);

      await engine.stop();
      assert.strictEqual(engine.isRunning, false);

      // Ensure start() promise resolves (loop exits because isRunning=false)
      await startPromise;

      wss.close();
    });

    test('killBot() closes all open shadow positions and stops engine', async () => {
      setupDefaultDbMock();

      const wss = new WebSocketServer({ noServer: true });
      const redisMock = createRedisMock();
      const engine = new TradingEngine(wss, redisMock as any);
      engine.isExchangeEnabled = false;
      engine.exchange = createStubExchange() as any;
      await engine.init();

      // Manually inject an open shadow trade so killBot has something to close
      engine.shadowTrader.portfolios[RiskMode.MODERATE].openTrades.push({
        id: 'test-kill-1',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 1,
        price: 50000,
        status: 'open',
        timestamp: Date.now(),
        risk_mode: RiskMode.MODERATE,
        leverage: 1,
        stopLoss: 49000,
        takeProfit: 52000,
        candlesHeld: 0,
        isRunner: false,
      } as any);

      await engine.killBot();
      assert.strictEqual(engine.isRunning, false);
      // The open trade should have been closed (removed from openTrades)
      assert.strictEqual(engine.shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length, 0);

      wss.close();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // (b) REST auth
  // ═════════════════════════════════════════════════════════════════════════

  describe('(b) REST auth (requireRole)', () => {
    let app: express.Application;

    beforeEach(() => {
      setupDefaultDbMock();
      process.env.API_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
      process.env.API_TRADER_TOKEN = TEST_TRADER_TOKEN;
      app = express();
      app.use(express.json());
      app.use('/api', apiRouter);
    });

    afterEach(() => {
      delete process.env.API_ADMIN_TOKEN;
      delete process.env.API_TRADER_TOKEN;
      delete process.env.API_AUTH_TOKEN;
    });

    test('admin route rejects missing token with 401', async () => {
      // /settings is an admin route
      const res = await request(app).get('/api/settings');
      assert.strictEqual(res.status, 401);
      assert.ok(res.body.error);
    });

    test('admin route rejects trader token with 403', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-api-token', TEST_TRADER_TOKEN);
      assert.strictEqual(res.status, 403);
      assert.ok(res.body.error);
    });

    test('admin route accepts admin token', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-api-token', TEST_ADMIN_TOKEN);
      assert.strictEqual(res.status, 200);
    });

    test('admin route accepts admin token via Bearer header', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
      assert.strictEqual(res.status, 200);
    });

    test('trader route accepts trader token', async () => {
      // /trades is a trader route
      const res = await request(app)
        .get('/api/trades')
        .set('x-api-token', TEST_TRADER_TOKEN);
      assert.strictEqual(res.status, 200);
    });

    test('trader route accepts admin token (admin >= trader)', async () => {
      const res = await request(app)
        .get('/api/trades')
        .set('x-api-token', TEST_ADMIN_TOKEN);
      assert.strictEqual(res.status, 200);
    });

    test('trader route rejects missing token with 401', async () => {
      const res = await request(app).get('/api/trades');
      assert.strictEqual(res.status, 401);
    });

    test('trader route rejects invalid token with 401', async () => {
      const res = await request(app)
        .get('/api/trades')
        .set('x-api-token', 'completely-wrong-token');
      assert.strictEqual(res.status, 401);
    });

    test('public route (/health/live) accessible without auth', async () => {
      const res = await request(app).get('/api/health/live');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ok');
    });

    test('requireRole returns 503 when no tokens are configured (fail-closed)', async () => {
      // Remove tokens for this test
      delete process.env.API_ADMIN_TOKEN;
      delete process.env.API_TRADER_TOKEN;
      delete process.env.API_AUTH_TOKEN;

      const res = await request(app).get('/api/settings');
      assert.strictEqual(res.status, 503);
      assert.ok(res.body.error);
      assert.ok(res.body.hint);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // (c) WebSocket auth (T3 first-message handshake)
  // ═════════════════════════════════════════════════════════════════════════

  describe('(c) WebSocket auth handshake', () => {
    let httpServer: HttpServer;
    let wss: WebSocketServer;
    let port: number;

    beforeEach((t, done) => {
      process.env.API_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
      process.env.API_TRADER_TOKEN = TEST_TRADER_TOKEN;
      // Short timeout for fast test execution
      process.env.WS_AUTH_TIMEOUT_MS = '200';

      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      (wss as any).getWsAuthTokens = () => ({
        adminToken: process.env.API_ADMIN_TOKEN || '',
        traderToken: process.env.API_TRADER_TOKEN || '',
      });
      setupWebsocket(wss);

      httpServer.listen(0, () => {
        const addr = httpServer.address() as any;
        port = addr.port;
        done();
      });
    });

    afterEach((t, done) => {
      delete process.env.API_ADMIN_TOKEN;
      delete process.env.API_TRADER_TOKEN;
      // Reset to default
      process.env.WS_AUTH_TIMEOUT_MS = '5000';
      wss.close();
      httpServer.close(() => done());
    });

    test('unauthenticated socket (no auth message) is closed with 4401 after timeout', async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      assert.strictEqual(closeEvent.code, 4401);
      ws.close();
    });

    test('authenticated socket receives auth_ok with role', async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      // Send auth message
      ws.send(JSON.stringify({ type: 'auth', token: TEST_TRADER_TOKEN }));

      // Wait for auth_ok
      const authOk = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('auth_ok timeout')), 3000);
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth_ok') {
            clearTimeout(timeout);
            resolve(msg);
          }
        });
        ws.on('close', (code: number) => {
          clearTimeout(timeout);
          reject(new Error(`socket closed with code ${code} before auth_ok`));
        });
      });

      assert.strictEqual(authOk.type, 'auth_ok');
      assert.strictEqual(authOk.role, 'trader');
      ws.close();
    });

    test('invalid token is rejected with close 4401', async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      ws.send(JSON.stringify({ type: 'auth', token: 'wrong-token' }));

      const closeEvent = await new Promise<{ code: number }>((resolve) => {
        ws.on('close', (code: number) => resolve({ code }));
      });

      assert.strictEqual(closeEvent.code, 4401);
      ws.close();
    });

    test('authenticated socket receives a broadcast after auth_ok', async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      // Authenticate first
      ws.send(JSON.stringify({ type: 'auth', token: TEST_ADMIN_TOKEN }));

      // Wait for auth_ok
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('auth_ok timeout')), 3000);
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth_ok') {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.on('close', (code: number) => {
          clearTimeout(timeout);
          reject(new Error(`socket closed ${code}`));
        });
      });

      // Now trigger a broadcast via the wss — simulating engine.broadcast()
      // The broadcast method checks (client as any).authed === true
      const broadcastMsg = { type: 'status', data: { isRunning: true, symbol: 'BTC/USDT' } };
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && (client as any).authed === true) {
          client.send(JSON.stringify(broadcastMsg));
        }
      });

      // Wait for the broadcast message
      const received = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('broadcast timeout')), 3000);
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'status') {
            clearTimeout(timeout);
            resolve(msg);
          }
        });
      });

      assert.strictEqual(received.type, 'status');
      assert.strictEqual(received.data.isRunning, true);
      ws.close();
    });

    test('post-auth ping receives pong', async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      // Authenticate
      ws.send(JSON.stringify({ type: 'auth', token: TEST_TRADER_TOKEN }));

      // Wait for auth_ok
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('auth_ok timeout')), 3000);
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth_ok') {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.on('close', (code: number) => {
          clearTimeout(timeout);
          reject(new Error(`socket closed ${code}`));
        });
      });

      // Send ping
      ws.send(JSON.stringify({ type: 'ping' }));

      // Wait for pong
      const pong = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('pong timeout')), 3000);
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'pong') {
            clearTimeout(timeout);
            resolve(msg);
          }
        });
      });

      assert.strictEqual(pong.type, 'pong');
      ws.close();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // (d) Persistence round-trip — shadow trade write + close
  // ═════════════════════════════════════════════════════════════════════════

  describe('(d) Persistence round-trip', () => {

    test('signal produces a shadow trade INSERT, then closeTrade UPDATE sets status=closed with pnl and exit fields', async () => {
      const { mockFn, recorded } = createRecordingDbMock();
      setMockRunQuery(mockFn as any);

      const shadowTrader = new ShadowTrader();
      await shadowTrader.init();

      // Process a buy signal at a fixed price
      const signal = {
        symbol: 'BTC/USDT',
        side: 'buy',
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        confidence: 90, // above moderate threshold of 75
      };

      await shadowTrader.processSignal(
        signal,
        50000,         // currentPrice
        'moderate',    // activeMode
        undefined,     // balanceManager (not needed for shadow-only)
        undefined,     // exchange (no live orders)
        'strongbull'   // regime (in moderate activeRegimes)
      );

      // At least one mode should have an open trade (moderate accepts strongbull)
      const moderateTrades = shadowTrader.portfolios[RiskMode.MODERATE].openTrades;
      assert.ok(moderateTrades.length > 0, 'moderate portfolio should have at least one open trade');

      // Verify the INSERT was recorded
      const insertCalls = recorded.filter(r =>
        r.sql.includes('INSERT INTO shadow_trades')
      );
      assert.ok(insertCalls.length > 0, 'should have recorded at least one INSERT INTO shadow_trades');

      // Verify INSERT contains expected columns
      const insertSql = insertCalls[0].sql;
      assert.ok(insertSql.includes('id'), 'INSERT should include id column');
      assert.ok(insertSql.includes('symbol'), 'INSERT should include symbol column');
      assert.ok(insertSql.includes('side'), 'INSERT should include side column');
      assert.ok(insertSql.includes('amount'), 'INSERT should include amount column');
      assert.ok(insertSql.includes('price'), 'INSERT should include price column');
      assert.ok(insertSql.includes('status'), 'INSERT should include status column');
      assert.ok(insertSql.includes('risk_mode'), 'INSERT should include risk_mode column');

      // Verify INSERT params include the signal data
      const insertParams = insertCalls[0].params;
      assert.ok(insertParams[0].includes('shadow-'), 'first param should be trade id starting with shadow-');
      assert.strictEqual(insertParams[1], 'BTC/USDT');
      assert.strictEqual(insertParams[2], 'buy');

      // Now close the trade at a higher price (profit)
      const tradeId = moderateTrades[0].id;
      const exitPrice = 51000; // +1000 profit

      const closed = await shadowTrader.closeTrade(
        tradeId,
        exitPrice,
        'moderate',    // activeMode
        undefined,     // balanceManager
        undefined      // exchange
      );

      assert.strictEqual(closed, true, 'closeTrade should return true');

      // Trade should be removed from openTrades
      assert.strictEqual(
        shadowTrader.portfolios[RiskMode.MODERATE].openTrades.length,
        0,
        'moderate portfolio should have no open trades after close'
      );

      // Verify the UPDATE was recorded
      const updateCalls = recorded.filter(r =>
        r.sql.includes('UPDATE shadow_trades') &&
        r.sql.includes('status') &&
        r.sql.includes('pnl') &&
        r.sql.includes('exit_price') &&
        r.sql.includes('exit_timestamp')
      );
      assert.ok(updateCalls.length > 0, 'should have recorded an UPDATE shadow_trades with close fields');

      // Verify UPDATE sets status='closed'
      const updateSql = updateCalls[0].sql;
      assert.ok(updateSql.includes("'closed'"), "UPDATE should set status='closed'");

      // Verify UPDATE params: pnl, exit_price, exit_timestamp, tradeId
      const updateParams = updateCalls[0].params;
      assert.ok(typeof updateParams[0] === 'number', 'pnl should be a number');
      assert.strictEqual(updateParams[1], exitPrice, 'exit_price should match the close price');
      assert.ok(typeof updateParams[2] === 'number', 'exit_timestamp should be a number');
      assert.strictEqual(updateParams[3], tradeId, 'last param should be the trade id');

      // For a buy trade closed at a higher price, pnl should be positive
      assert.ok(updateParams[0] > 0, 'pnl should be positive for a profitable buy trade');

      // Also verify audit_trades were logged (open + close)
      const auditInserts = recorded.filter(r => r.sql.includes('INSERT INTO audit_trades'));
      assert.ok(auditInserts.length >= 2, 'should have at least 2 audit_trades INSERTs (open + close)');
    });

    test('closeTrade on non-existent trade returns false', async () => {
      const { mockFn } = createRecordingDbMock();
      setMockRunQuery(mockFn as any);

      const shadowTrader = new ShadowTrader();
      await shadowTrader.init();

      const result = await shadowTrader.closeTrade('nonexistent-id', 50000, 'moderate');
      assert.strictEqual(result, false);
    });

    test('persistence round-trip: losing trade produces negative pnl', async () => {
      const { mockFn, recorded } = createRecordingDbMock();
      setMockRunQuery(mockFn as any);

      const shadowTrader = new ShadowTrader();
      await shadowTrader.init();

      const signal = {
        symbol: 'BTC/USDT',
        side: 'buy',
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        confidence: 90,
      };

      await shadowTrader.processSignal(signal, 50000, 'moderate', undefined, undefined, 'strongbull');

      const tradeId = shadowTrader.portfolios[RiskMode.MODERATE].openTrades[0].id;
      await shadowTrader.closeTrade(tradeId, 49000, 'moderate'); // close at a loss

      // The closeTrade method writes an audit_trades entry with 'manual_close' reason
      const auditCloses = recorded.filter(r =>
        r.sql.includes('INSERT INTO audit_trades') &&
        r.params.includes('close')
      );
      assert.ok(auditCloses.length > 0, 'should have an audit_trades entry for the close event');

      // For a buy closed below entry, pnl should be negative
      const updateCalls = recorded.filter(r =>
        r.sql.includes('UPDATE shadow_trades') &&
        r.sql.includes('pnl')
      );
      assert.ok(updateCalls.length > 0);
      // params[0] is pnl in the UPDATE
      assert.ok(updateCalls[0].params[0] < 0, 'pnl should be negative for a losing trade');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Network-freedom assertion
  // ═════════════════════════════════════════════════════════════════════════

  describe('Network-freedom guard', () => {
    test('global fetch is patched to throw (no outbound HTTP allowed)', () => {
      assert.ok(
        typeof globalThis.fetch === 'function',
        'fetch should be a function (patched)'
      );
      // The patched fetch throws — verify it does
      assert.throws(
        () => globalThis.fetch('http://example.com'),
        /NETWORK GUARD/,
        'patched fetch should throw NETWORK GUARD error'
      );
    });

    test('ML_ENABLED, GEMMA_ENABLED, FREQTRADE_ENABLED are false', () => {
      assert.strictEqual(process.env.ML_ENABLED, 'false');
      assert.strictEqual(process.env.GEMMA_ENABLED, 'false');
      assert.strictEqual(process.env.FREQTRADE_ENABLED, 'false');
    });
  });
});
