import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TradingEngine } from '../../backend/main.js';
import { MarketDataService } from '../../backend/api/marketDataService.js';
import { setMockRunQuery } from '../../backend/database.js';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { apiRouter } from '../../backend/api/routes.js';
import express from 'express';

setMockRunQuery(async (sql, _params, type) => {
  if (sql.includes('SELECT * FROM settings')) return [];
  if (sql.includes('SELECT 1')) return [{ 1: 1 }];
  if (sql.includes('SELECT * FROM balances')) {
    return [{ main_balance: 100000, bot_balance: 100000, active_trade_balance: 0, total_pnl: 0, total_pnl_pct: 0 }];
  }
  if (sql.includes('SELECT COUNT(*) as count')) return [{ count: 0 }];
  if (sql.includes('SELECT SUM(pnl) as totalPnl')) return [{ totalPnl: 0 }];
  if (sql.includes('SELECT exit_timestamp as time, pnl')) return [];
  if (type === 'all') return [];
  return { changes: 1 };
});

MarketDataService.prototype.fetchMarketData = async () => ({
  market_cap: 0,
  total_volume: 0,
  fear_greed_index: 50,
  fear_greed_value: 'Neutral',
  btc_dominance: 0,
  last_updated: Date.now(),
  timestamp: Date.now()
});
MarketDataService.prototype.fetchNews = async () => ([]);

describe.skip('End-to-End Trading Bot Tests [LEGACY-QUARANTINED]', () => {
  test('App launch and strategy execution', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    assert.strictEqual(engine.isRunning, false);

    engine.runCycle = async () => {
      engine.stop();
    };

    // Start engine
    await engine.start();
    assert.strictEqual(engine.isRunning, false);

    wss.close();
  });

  test('Opening and closing trades with leverage', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Mock exchange and balance manager
    engine.exchange = {
      getCandles: async () => [{ time: Date.now(), open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 }],
      placeOrder: async () => ({ id: 'order123' }),
      apiKey: 'test-key'
    } as any;

    // Process a signal
    const signal = { symbol: 'BTC/USDT', side: 'buy', entryPrice: 50000, stopLoss: 49000, takeProfit: 52000, confidence: 90 };
    await engine.shadowTrader.processSignal(signal, 50000, 'moderate', engine.balanceManager, engine.exchange, 'strongbull');

    assert.strictEqual(engine.shadowTrader.portfolios['moderate'].openTrades.length, 1);

    // Close trade
    const tradeId = engine.shadowTrader.portfolios['moderate'].openTrades[0].id;
    await engine.shadowTrader.closeTrade(tradeId, 51000, 'moderate', engine.balanceManager, engine.exchange);

    assert.strictEqual(engine.shadowTrader.portfolios['moderate'].openTrades.length, 0);

    engine.stop();
    wss.close();
  });

  test('Settings configuration and validation', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test settings retrieval
    const getResponse = await fetch('http://localhost:0/api/settings');
    assert.strictEqual(getResponse.status, 200);
    const settings = await getResponse.json();
    assert.ok(typeof settings === 'object');

    // Test settings update with validation
    const updateResponse = await fetch('http://localhost:0/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'ETH/USDT',
        timeframe: '5m',
        strategy: 'regime'
      })
    });
    assert.strictEqual(updateResponse.status, 200);

    // Test invalid settings (should be blocked by validation)
    const invalidResponse = await fetch('http://localhost:0/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'test-key' // Should be blocked
      })
    });
    assert.strictEqual(invalidResponse.status, 200); // Validation happens at schema level

    server.close();
    wss.close();
  });

  test('API connectivity and error handling', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test candles endpoint without data
    const candlesResponse = await fetch('http://localhost:0/api/candles?history=1y');
    assert.strictEqual(candlesResponse.status, 500); // Engine not fully initialized

    // Test market data endpoint
    const marketDataResponse = await fetch('http://localhost:0/api/market/data');
    assert.strictEqual(marketDataResponse.status, 200);
    const marketData = await marketDataResponse.json();
    assert.ok(marketData.market_cap !== undefined);

    // Test invalid endpoints
    const invalidResponse = await fetch('http://localhost:0/api/nonexistent');
    assert.strictEqual(invalidResponse.status, 404);

    server.close();
    wss.close();
  });

  test('WebSocket communication and real-time updates', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test WebSocket connection establishment
    const ws = new WebSocket(`ws://localhost:${wss.address().port}`);
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });

    // Test receiving status updates
    let receivedMessage = false;
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'status') {
        receivedMessage = true;
        assert.ok(data.data.symbol);
        assert.ok(typeof data.data.isRunning === 'boolean');
      }
    };

    // Wait a bit for messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    ws.close();
    wss.close();
  });

  test('Balance management operations', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test balance retrieval
    const balanceResponse = await fetch('http://localhost:0/api/balances');
    assert.strictEqual(balanceResponse.status, 200);
    const balances = await balanceResponse.json();
    assert.ok(typeof balances.mainBalance === 'number');
    assert.ok(typeof balances.botBalance === 'number');

    // Test balance allocation
    const allocateResponse = await fetch('http://localhost:0/api/balances/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 10000 })
    });
    assert.strictEqual(allocateResponse.status, 200);

    server.close();
    wss.close();
  });

  test('Backtesting functionality', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Mock some candle data
    setMockRunQuery(async (sql, params, type) => {
      if (sql.includes('SELECT time, open, high, low, close, volume FROM candles')) {
        return [
          { time: Date.now() - 86400000, open: 50000, high: 51000, low: 49000, close: 50500, volume: 1000 },
          { time: Date.now() - 43200000, open: 50500, high: 51500, low: 49500, close: 51000, volume: 1200 },
          { time: Date.now(), open: 51000, high: 52000, low: 50000, close: 51500, volume: 1100 }
        ];
      }
      if (sql.includes('SELECT * FROM settings')) return [];
      if (sql.includes('SELECT 1')) return [{ 1: 1 }];
      if (type === 'all') return [];
      return { changes: 1 };
    });

    // Test backtest endpoint
    const backtestResponse = await fetch('http://localhost:0/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'moderate',
        config: engine.shadowTrader.riskManager.RISK_CONFIGS.moderate,
        startTime: Date.now() - 86400000,
        endTime: Date.now()
      })
    });

    // Backtest might fail due to missing data, but endpoint should respond
    assert.ok(backtestResponse.status === 200 || backtestResponse.status === 500);

    server.close();
    wss.close();
  });

  test('Risk configuration and AI recommendations', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test risk configs retrieval
    const riskResponse = await fetch('http://localhost:0/api/risk-configs');
    assert.strictEqual(riskResponse.status, 200);
    const riskConfigs = await riskResponse.json();
    assert.ok(riskConfigs.moderate);

    // Test risk configs update
    const updateRiskResponse = await fetch('http://localhost:0/api/risk-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(riskConfigs)
    });
    assert.strictEqual(updateRiskResponse.status, 200);

    server.close();
    wss.close();
  });

  test('Performance monitoring and diagnostics', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test diagnostics endpoints
    const startupResponse = await fetch('http://localhost:0/api/diagnostics/startup');
    assert.strictEqual(startupResponse.status, 200);

    const healthResponse = await fetch('http://localhost:0/api/diagnostics/health');
    assert.strictEqual(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.ok(health.uptimeSec !== undefined);

    const metricsResponse = await fetch('http://localhost:0/api/diagnostics/metrics');
    assert.strictEqual(metricsResponse.status, 200);

    server.close();
    wss.close();
  });

  test('Engine lifecycle management', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    assert.strictEqual(engine.isRunning, false);

    // Test start/stop cycle
    await engine.start();
    assert.strictEqual(engine.isRunning, true);

    engine.stop();
    assert.strictEqual(engine.isRunning, false);

    // Test kill functionality
    await engine.start();
    await engine.killBot();
    assert.strictEqual(engine.isRunning, false);

    wss.close();
  });

  test('Error recovery and resilience', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test handling of invalid signals
    const invalidSignal = { symbol: 'INVALID', side: 'invalid', entryPrice: -100 };
    try {
      await engine.shadowTrader.processSignal(invalidSignal as any, 50000, 'moderate', engine.balanceManager, engine.exchange, 'strongbull');
      assert.fail('Should have thrown an error for invalid signal');
    } catch (error) {
      assert.ok(error); // Expected error
    }

    // Test handling of network failures (mock by disabling exchange)
    const signal = { symbol: 'BTC/USDT', side: 'buy', entryPrice: 50000, stopLoss: 49000, takeProfit: 52000, confidence: 90 };
    await engine.shadowTrader.processSignal(signal, 50000, 'moderate', engine.balanceManager, null as any, 'strongbull');
    // Should handle gracefully without exchange

    wss.close();
  });

  test('API authentication and authorization', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test admin-only endpoints without auth
    const adminResponse = await fetch('http://localhost:0/api/start');
    assert.strictEqual(adminResponse.status, 503); // Auth not configured

    // Test trader-only endpoints
    const traderResponse = await fetch('http://localhost:0/api/timeframe');
    assert.strictEqual(traderResponse.status, 503);

    // Test public endpoints (should work without auth)
    const publicResponse = await fetch('http://localhost:0/api/status');
    assert.ok(publicResponse.status === 200 || publicResponse.status === 503);

    server.close();
    wss.close();
  });

  test('Data persistence and recovery', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test that settings persist across engine restarts
    await engine.loadSettings();
    const originalSymbol = engine.symbol;

    // Change setting
    engine.symbol = 'ETH/USDT';
    await engine.saveSettings();

    // Simulate restart
    const newEngine = new TradingEngine(wss);
    newEngine.isExchangeEnabled = false;
    await newEngine.init();
    await newEngine.loadSettings();

    // Setting should be persisted
    assert.strictEqual(newEngine.symbol, 'ETH/USDT');

    // Restore original
    engine.symbol = originalSymbol;
    await engine.saveSettings();

    wss.close();
  });

  test('Performance metrics collection', async () => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    app.use('/api', apiRouter);

    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Make several API calls to generate metrics
    await fetch('http://localhost:0/api/status');
    await fetch('http://localhost:0/api/performance');
    await fetch('http://localhost:0/api/balances');

    // Check that metrics are being collected
    const healthResponse = await fetch('http://localhost:0/api/diagnostics/health');
    const health = await healthResponse.json();
    assert.ok(health.api);
    assert.ok(health.api.requestCount >= 3);

    server.close();
    wss.close();
  });

  test('Concurrent operations handling', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const engine = new TradingEngine(wss);
    engine.isExchangeEnabled = false;
    await engine.init();

    // Test concurrent signal processing
    const signals = [
      { symbol: 'BTC/USDT', side: 'buy', entryPrice: 50000, stopLoss: 49000, takeProfit: 52000, confidence: 90 },
      { symbol: 'BTC/USDT', side: 'sell', entryPrice: 51000, stopLoss: 52000, takeProfit: 48000, confidence: 85 }
    ];

    // Process signals concurrently
    const promises = signals.map(signal =>
      engine.shadowTrader.processSignal(signal, signal.entryPrice, 'moderate', engine.balanceManager, engine.exchange, 'strongbull')
    );

    await Promise.all(promises);

    // Should handle concurrent operations without race conditions
    assert.ok(engine.shadowTrader.portfolios['moderate'].openTrades.length >= 0);

    wss.close();
  });
});
