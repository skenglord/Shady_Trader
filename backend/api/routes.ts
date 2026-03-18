import { Router } from 'express';
import { runQuery } from '../database.js';
import { getTradingEngine } from '../main.js';
import { RiskMode, DEFAULT_RISK_CONFIGS } from '../risk/manager.js';
import multer from 'multer';
import { parse } from 'csv-parse';
import fs from 'fs';

const upload = multer({ dest: 'uploads/' });
export const apiRouter = Router();

apiRouter.use((req, res, next) => {
  console.log('apiRouter hit:', req.url);
  next();
});

apiRouter.get('/status', (req, res) => {
  const engine = getTradingEngine();
  res.json({
    isRunning: engine?.isRunning || false,
    currentRegime: engine?.currentRegime || 'uncertain',
    symbol: engine?.symbol || 'BTC/USDT',
    timeframe: engine?.timeframe || '15m'
  });
});

apiRouter.post('/start', (req, res) => {
  const engine = getTradingEngine();
  if (engine && !engine.isRunning) {
    engine.start().catch(console.error);
    res.json({ success: true, message: 'Trading engine started' });
  } else {
    res.status(400).json({ success: false, message: 'Engine already running or not initialized' });
  }
});

apiRouter.post('/stop', (req, res) => {
  const engine = getTradingEngine();
  if (engine && engine.isRunning) {
    engine.stop();
    res.json({ success: true, message: 'Trading engine stopped' });
  } else {
    res.status(400).json({ success: false, message: 'Engine not running' });
  }
});

apiRouter.post('/timeframe', async (req, res) => {
  const engine = getTradingEngine();
  const { timeframe } = req.body;
  
  if (!timeframe) {
    return res.status(400).json({ success: false, message: 'Timeframe is required' });
  }

  await runQuery(`
    INSERT OR REPLACE INTO settings (key, value)
    VALUES (?, ?)
  `, ['timeframe', timeframe]);

  if (engine) {
    engine.setTimeframe(timeframe);
    res.json({ success: true, message: `Timeframe updated to ${timeframe}` });
  } else {
    res.status(500).json({ success: false, message: 'Engine not initialized' });
  }
});

apiRouter.get('/candles', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      const history = req.query.history as string;
      let candles;
      
      if (history === '1y') {
        const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
        // Calculate limit based on timeframe
        let limit = 35000; // default for 15m
        if (engine.timeframe === '1h') limit = 8760;
        else if (engine.timeframe === '1d') limit = 365;
        else if (engine.timeframe === '5m') limit = 105120;
        
        if (engine.exchange) {
          candles = await engine.exchange.getHistoricalCandles(engine.symbol, engine.timeframe, oneYearAgo, limit);
        } else {
          candles = [];
        }
      } else {
        if (engine.exchange) {
          candles = await engine.exchange.getCandles(engine.symbol, engine.timeframe, 1000);
        } else {
          candles = [];
        }
      }
      
      if (candles.length >= 50) {
        const df = engine.indicators.calculateAll(candles);
        res.json(df);
      } else {
        res.json(candles);
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/market/data', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const data = await engine.marketDataService.getLatestMarketData();
    res.json(data);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/market/news', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const news = await engine.marketDataService.getLatestNews();
    res.json(news);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/market/refresh', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    await engine.marketDataService.fetchMarketData();
    await engine.marketDataService.fetchNews();
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/optimize', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    await engine.optimizationEngine.optimize(engine.currentRegime);
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/performance', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const performance = engine.shadowTrader.getPerformance();
    res.json(performance);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/trades', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  
  const trades = await runQuery(`
    SELECT * FROM shadow_trades
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(trades);
});

apiRouter.get('/history/regime', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  
  const history = await runQuery(`
    SELECT * FROM regime_history
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], 'all');
  res.json(history);
});

apiRouter.post('/settings', async (req, res) => {
  const settings = req.body;
  
  for (const [key, value] of Object.entries(settings)) {
    // Skip API keys and exchange settings
    if (['apiKey', 'apiSecret', 'apiPassword', 'exchange', 'apiProviders'].includes(key)) {
      continue;
    }
    await runQuery(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES (?, ?)
    `, [key, String(value)]);
  }
  
  const engine = getTradingEngine();
  if (engine) {
    engine.loadSettings();
  }
  
  res.json({ success: true });
});

apiRouter.get('/settings', async (req, res) => {
  const settings = await runQuery(`SELECT * FROM settings`, [], 'all');
  
  const result: Record<string, string> = {};
  for (const row of settings as any[]) {
    // Skip API keys and exchange settings in response
    if (['apiKey', 'apiSecret', 'apiPassword', 'exchange', 'apiProviders'].includes(row.key)) {
      continue;
    }
    result[row.key] = row.value;
  }
  
  res.json(result);
});

apiRouter.get('/positions/open', (req, res) => {
  console.log('GET /api/positions/open hit');
  const engine = getTradingEngine();
  if (engine) {
    const allOpenTrades = [];
    for (const mode of Object.values(RiskMode)) {
      const portfolio = engine.shadowTrader.portfolios[mode as RiskMode];
      if (portfolio && portfolio.openTrades) {
        allOpenTrades.push(...portfolio.openTrades);
      }
    }
    res.json(allOpenTrades);
  } else {
    console.log('Engine not initialized');
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/positions/close', async (req, res) => {
  const { tradeId, currentPrice } = req.body;
  const engine = getTradingEngine();
  if (engine) {
    const success = await engine.shadowTrader.closeTrade(
      tradeId, 
      currentPrice, 
      engine.activeMode, 
      engine.balanceManager, 
      engine.exchange
    );
    res.json({ success });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/positions/update', async (req, res) => {
  const { tradeId, stopLoss, takeProfit } = req.body;
  const engine = getTradingEngine();
  if (engine) {
    const success = await engine.shadowTrader.updateTradeParams(tradeId, stopLoss, takeProfit);
    res.json({ success });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/risk-configs', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    res.json(engine.shadowTrader.riskManager.RISK_CONFIGS);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/risk-configs', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    engine.shadowTrader.riskManager.saveConfigs(req.body);
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/risk-configs/reset', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    engine.shadowTrader.riskManager.saveConfigs(DEFAULT_RISK_CONFIGS);
    res.json({ success: true, configs: DEFAULT_RISK_CONFIGS });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

import { GoogleGenAI, Type } from '@google/genai';

let aiRecommendationsEnabled = true;

apiRouter.post('/risk-configs/ai-recommend', async (req, res) => {
  const engine = getTradingEngine();
  if (!engine) {
    return res.status(500).json({ error: 'Engine not initialized' });
  }
  
  const currentRegime = engine.currentRegime;
  const currentConfigs = JSON.parse(JSON.stringify(engine.shadowTrader.riskManager.RISK_CONFIGS));
  
  if (!aiRecommendationsEnabled) {
    // Fallback immediately
    for (const mode of Object.values(RiskMode)) {
      if (currentRegime === 'strong_bull' || currentRegime === 'bear') {
        currentConfigs[mode].tpMultiplier = Math.max(1.5, currentConfigs[mode].tpMultiplier * 1.2);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 0.8);
      } else if (currentRegime === 'sideways') {
        currentConfigs[mode].tpMultiplier = Math.max(1.0, currentConfigs[mode].tpMultiplier * 0.8);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 1.2);
      }
    }
    return res.json({ success: true, configs: currentConfigs });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set.");
    }
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `You are an expert quantitative trader. The current market regime is "${currentRegime}". 
    The current risk configurations for different modes are:
    ${JSON.stringify(currentConfigs, null, 2)}
    
    Please analyze the market regime and recommend adjustments to the risk configurations (maxRiskPerTrade, maxDrawdown, confidenceThreshold, tpMultiplier, slMultiplier, leverage) for each mode to optimize performance in this regime.
    Return the updated configurations in JSON format.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            ultra_conservative: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            conservative: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            moderate: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            aggressive: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
            degen: { type: Type.OBJECT, properties: { maxRiskPerTrade: { type: Type.NUMBER }, maxDrawdown: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, tpMultiplier: { type: Type.NUMBER }, slMultiplier: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } }
          }
        }
      }
    });

    if (response.text) {
      const recommendedConfigs = JSON.parse(response.text);
      
      // Merge recommended configs with existing descriptions and maxConcurrentPositions
      for (const mode of Object.keys(currentConfigs)) {
        if (recommendedConfigs[mode]) {
          currentConfigs[mode] = { ...currentConfigs[mode], ...recommendedConfigs[mode] };
        }
      }
      
      res.json({ success: true, configs: currentConfigs });
    } else {
      throw new Error("No response from AI");
    }
  } catch (error: any) {
    if (error.message && error.message.includes("API_KEY_INVALID")) {
      console.error("AI Recommendation failed: Invalid API Key. Disabling AI features.");
      aiRecommendationsEnabled = false;
    } else {
      console.error("AI Recommendation failed:", error);
    }
    // Fallback to simple logic
    for (const mode of Object.values(RiskMode)) {
      if (currentRegime === 'strong_bull' || currentRegime === 'bear') {
        currentConfigs[mode].tpMultiplier = Math.max(1.5, currentConfigs[mode].tpMultiplier * 1.2);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 0.8);
      } else if (currentRegime === 'sideways') {
        currentConfigs[mode].tpMultiplier = Math.max(1.0, currentConfigs[mode].tpMultiplier * 0.8);
        currentConfigs[mode].slMultiplier = Math.max(0.5, currentConfigs[mode].slMultiplier * 1.2);
      }
    }
    res.json({ success: true, configs: currentConfigs });
  }
});

apiRouter.post('/backtest', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { mode, config, startTime, endTime } = req.body;
    const result = await engine.runBacktest(mode, config, startTime, endTime);
    res.json(result);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.get('/balances', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    res.json(await engine.balanceManager.getBalances());
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/allocate', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { amount } = req.body;
    try {
      await engine.balanceManager.allocateToBot(amount);
      // Update the active portfolio initial balance to reflect the new allocation
      const portfolio = engine.shadowTrader.portfolios[engine.activeMode as any];
      if (portfolio) {
        portfolio.initialBalance += amount;
        portfolio.balance += amount;
      }
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/withdraw', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { amount } = req.body;
    try {
      await engine.balanceManager.withdrawFromBot(amount);
      const portfolio = engine.shadowTrader.portfolios[engine.activeMode as any];
      if (portfolio) {
        portfolio.initialBalance -= amount;
        portfolio.balance -= amount;
      }
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/half', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      const current = await engine.balanceManager.getBalances();
      const amount = current.botBalance / 2;
      await engine.balanceManager.halfBotBalance();
      const portfolio = engine.shadowTrader.portfolios[engine.activeMode as any];
      if (portfolio) {
        portfolio.initialBalance -= amount;
        portfolio.balance -= amount;
      }
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/balances/double', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      const current = await engine.balanceManager.getBalances();
      const amount = current.botBalance;
      await engine.balanceManager.doubleBotBalance();
      const portfolio = engine.shadowTrader.portfolios[engine.activeMode as any];
      if (portfolio) {
        portfolio.initialBalance += amount;
        portfolio.balance += amount;
      }
      res.json({ success: true, balances: await engine.balanceManager.getBalances() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/kill', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    try {
      await engine.killBot();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/active-mode', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { mode } = req.body;
    engine.activeMode = mode;
    await runQuery(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['activeMode', mode]);
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/regime/manual', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const { regime } = req.body;
    engine.manualRegime = regime;
    res.json({ success: true, regime });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});

apiRouter.post('/import-csv', upload.single('file'), async (req, res) => {
  const file = (req as any).file;
  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const results: any[] = [];
  fs.createReadStream(file.path)
    .pipe(parse({ columns: true, skip_empty_lines: true }))
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      try {
        // Save to database
        for (const row of results) {
          await runQuery(`
            INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            row.symbol,
            row.timeframe,
            row.time,
            row.open,
            row.high,
            row.low,
            row.close,
            row.volume
          ]);
        }
        res.json({ success: true, message: `Imported ${results.length} rows` });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      } finally {
        fs.unlinkSync(file.path);
      }
    })
    .on('error', (err) => {
      res.status(500).json({ error: err.message });
      fs.unlinkSync(file.path);
    });
});

apiRouter.post('/manual-trade', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    if (!engine.isRunning) {
      await engine.start().catch(console.error);
    }
    const { side, symbol, price, stopLoss, takeProfit } = req.body;
    
    // Create a manual signal
    const signal = {
      symbol,
      side,
      confidence: 100,
      entryPrice: price,
      stopLoss,
      takeProfit,
      reasoning: 'Manual entry',
      indicators: ['Manual']
    };

    try {
      // Execute trade
      await engine.shadowTrader.processSignal(signal, price, engine.activeMode, engine.balanceManager, engine.exchange);
      res.json({ success: true, message: 'Manual trade opened' });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  } else {
    res.status(400).json({ error: 'Engine not running' });
  }
});
