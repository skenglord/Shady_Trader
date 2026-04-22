import { WebSocketServer } from 'ws';
import { ExchangeConnector } from './exchange/connector.js';
import { IndicatorEngine } from './indicators/engine.js';
import { RegimeDetector, RegimeType } from './regime/detector.js';
import { SignalGenerator } from './strategy/signal_generator.js';
import { ShadowTrader } from './shadow/shadow_trader.js';
import { BalanceManager } from './balance/manager.js';
import { runQuery } from './database.js';
import { MarketDataService } from './api/marketDataService.js';
import { OptimizationEngine } from './strategy/optimization_engine.js';
import fs from 'fs';
import path from 'path';
import { logger } from './logging/logger.js';

export class TradingEngine {
  exchange: ExchangeConnector | null;
  isExchangeEnabled: boolean = true; // Re-enabled
  indicators: IndicatorEngine;
  regimeDetector: RegimeDetector;
  signalGenerator: SignalGenerator;
  shadowTrader: ShadowTrader;
  balanceManager: BalanceManager;
  marketDataService: MarketDataService;
  optimizationEngine: OptimizationEngine;
  wss: WebSocketServer;
  db: any; // Keep for now if used elsewhere, but remove from constructor
  currentRegime: RegimeType = RegimeType.UNCERTAIN;
  manualRegime: RegimeType | null = null;
  isRunning: boolean = false;
  symbol: string = 'BTC/USDT';
  timeframe: string = '15m';
  activeMode: string = 'moderate';
  strategy: string = 'regime';

  aiStrategySwitching: boolean = false;
  static aiStrategySwitchingEnabled = true;
  aiSignalGeneration: boolean = false;
  aiSentimentAnalysis: boolean = false;
  private marketPollInterval: NodeJS.Timeout | null = null;
  private optimizationInterval: NodeJS.Timeout | null = null;
  private startupDiagnostics: {
    exchangeEnabled: boolean;
    exchangeName: string;
    exchangeConfigured: boolean;
    exchangeReason: string;
  } = {
    exchangeEnabled: true,
    exchangeName: 'coinmarketcap',
    exchangeConfigured: false,
    exchangeReason: 'not_initialized'
  };

  constructor(wss: WebSocketServer) {
    logger.info('TradingEngine constructor called', { service: 'TradingEngine' });
    this.wss = wss;
    this.exchange = null; // Initialize as null
    this.indicators = new IndicatorEngine();
    this.regimeDetector = new RegimeDetector();
    this.signalGenerator = new SignalGenerator();
    this.shadowTrader = new ShadowTrader();
    this.balanceManager = new BalanceManager();
    this.marketDataService = new MarketDataService();
    this.optimizationEngine = new OptimizationEngine(this.shadowTrader.riskManager);

    // Setup DB backup cron (every hour)
    // setInterval(() => {
    //   this.backupDatabase();
    // }, 60 * 60 * 1000);

    this.startSchedulers();
  }

  startSchedulers() {
    if (!this.marketPollInterval) {
      this.marketPollInterval = setInterval(() => {
        this.marketDataService.fetchMarketData().catch(console.error);
        this.marketDataService.fetchNews().catch(console.error);
      }, 60 * 60 * 1000);
      this.marketPollInterval.unref?.();
    }

    if (!this.optimizationInterval) {
      this.optimizationInterval = setInterval(() => {
        this.optimizationEngine.optimize(this.currentRegime).catch(console.error);
      }, 6 * 60 * 60 * 1000);
      this.optimizationInterval.unref?.();
    }

    this.marketDataService.fetchMarketData().catch(console.error);
    this.marketDataService.fetchNews().catch(console.error);
  }

  stopSchedulers() {
    if (this.marketPollInterval) {
      clearInterval(this.marketPollInterval);
      this.marketPollInterval = null;
    }
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
      this.optimizationInterval = null;
    }
  }

  async init() {
    // Wait for database initialization
    let retry = 0;
    while (retry < 5) {
      try {
        await runQuery('SELECT 1');
        break;
      } catch (e) {
        retry++;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    await this.loadSettings();
  }

  backupDatabase() {
    try {
      const dbPath = path.join(process.cwd(), 'trading.db');
      const backupPath = path.join(process.cwd(), `trading_backup_${Date.now()}.db`);
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, backupPath);
        console.log(`Database backed up to ${backupPath}`);
        
        // Clean up old backups (keep last 5)
        const files = fs.readdirSync(process.cwd());
        const backups = files.filter(f => f.startsWith('trading_backup_')).sort();
        if (backups.length > 5) {
          const toDelete = backups.slice(0, backups.length - 5);
          toDelete.forEach(f => fs.unlinkSync(path.join(process.cwd(), f)));
        }
      }
    } catch (e) {
      console.error('Failed to backup database:', e);
    }
  }

  async loadSettings() {
    try {
      const settings = await runQuery(`SELECT * FROM settings`, [], 'all');
      const config: any = {};
      for (const row of settings as any[]) {
        config[row.key] = row.value;
      }
      
      if (config.symbol) {
        this.symbol = config.symbol;
        if (this.exchange) {
          this.exchange.setActiveSymbol(this.symbol);
        }
      }
      if (config.timeframe) this.timeframe = config.timeframe;
      if (config.activeMode) this.activeMode = config.activeMode;
      if (config.strategy) this.strategy = config.strategy;

      const exchangeName = String(
        config.exchange || process.env.EXCHANGE_NAME || 'coinmarketcap'
      ).toLowerCase();
      const exchangeApiKey = String(
        config.apiKey || process.env.EXCHANGE_API_KEY || ''
      );
      const exchangeApiSecret = String(
        config.apiSecret || process.env.EXCHANGE_API_SECRET || ''
      );
      const exchangeApiPassword = String(
        config.apiPassword || process.env.EXCHANGE_API_PASSWORD || ''
      );
      const useTestnet = String(
        config.exchangeUseTestnet || process.env.EXCHANGE_USE_TESTNET || 'true'
      ).toLowerCase() === 'true';
      
      this.aiStrategySwitching = config.aiStrategySwitching === 'true';
      this.aiSignalGeneration = config.aiSignalGeneration === 'true';
      this.aiSentimentAnalysis = config.aiSentimentAnalysis === 'true';
      
      this.startupDiagnostics = {
        exchangeEnabled: this.isExchangeEnabled,
        exchangeName,
        exchangeConfigured: false,
        exchangeReason: 'pending_validation'
      };

      if (this.isExchangeEnabled) {
        const requiresApiKey = exchangeName === 'coinmarketcap';
        if (requiresApiKey && !exchangeApiKey) {
          const message = `Exchange "${exchangeName}" requires EXCHANGE_API_KEY or persisted settings.apiKey`;
          if (process.env.NODE_ENV === 'production') {
            throw new Error(message);
          }
          console.warn(`[TradingEngine] ${message}. Exchange disabled until configured.`);
          this.exchange = null;
          this.startupDiagnostics.exchangeConfigured = false;
          this.startupDiagnostics.exchangeReason = message;
        } else {
          this.exchange = new ExchangeConnector(
            exchangeName,
            exchangeApiKey,
            exchangeApiSecret,
            exchangeApiPassword || undefined,
            useTestnet
          );
          this.exchange.setActiveSymbol(this.symbol);
          this.startupDiagnostics.exchangeConfigured = true;
          this.startupDiagnostics.exchangeReason = 'ok';
        }
      } else {
        this.exchange = null;
        this.startupDiagnostics.exchangeConfigured = false;
        this.startupDiagnostics.exchangeReason = 'exchange_disabled';
      }
      
      this.broadcast({ type: 'status', data: { symbol: this.symbol, timeframe: this.timeframe } });
      
      if (this.isRunning) {
        this.runCycle().catch(console.error);
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
      this.exchange = null;
      this.startupDiagnostics.exchangeConfigured = false;
      this.startupDiagnostics.exchangeReason = e instanceof Error ? e.message : 'load_settings_failed';
    }
  }

  async start() {
    this.startSchedulers();
    this.isRunning = true;
    this.shadowTrader.reset();
    logger.info('Trading engine started and reset', { service: 'TradingEngine' });
    this.broadcast({ type: 'status', data: { isRunning: true } });
    this.broadcast({ type: 'performance', data: this.shadowTrader.getPerformance() });

    while (this.isRunning) {
      try {
        await this.runCycle();
      } catch (error: any) {
        console.error('Error in trading cycle:', error);
        this.broadcast({ type: 'error', data: { message: error.message } });
      }
      
      // Wait for next cycle (e.g., 1 second)
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  stop() {
    this.isRunning = false;
    this.stopSchedulers();
    logger.info('Trading engine stopped', { service: 'TradingEngine' });
    this.broadcast({ type: 'status', data: { isRunning: false } });
  }

  async killBot() {
    this.stop();
    
    // Fetch current price to close trades accurately
    let currentPrice = 0;
    try {
      const candles = await this.exchange.getCandles(this.symbol, this.timeframe, 1);
      if (candles && candles.length > 0) {
        currentPrice = candles[0].close;
      }
    } catch (e) {
      console.error('Failed to fetch current price for killBot, using entry prices');
    }

    // Close all shadow positions
    for (const mode of Object.keys(this.shadowTrader.portfolios)) {
      const portfolio = this.shadowTrader.portfolios[mode as any];
      
      for (const trade of portfolio.openTrades) {
        const exitPrice = currentPrice || trade.price;
        let pnl = 0;
        if (trade.side === 'buy') {
          pnl = (exitPrice - trade.price) * trade.amount;
        } else {
          pnl = (trade.price - exitPrice) * trade.amount;
        }
        
        portfolio.balance += pnl;

        if (mode === this.activeMode) {
          const tradeCost = trade.amount * trade.price / trade.leverage;
          this.balanceManager.recordTradeResult(pnl, tradeCost);
          
          if (this.exchange && this.exchange.apiKey) {
            try {
              const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
              await this.exchange.placeOrder(trade.symbol, closeSide, trade.amount, 'market');
            } catch (e: any) {
              console.error(`Failed to execute live close order for ${trade.symbol}: ${e.message}`);
            }
          }
        }

        await runQuery(`
          UPDATE shadow_trades
          SET status = 'closed', pnl = ?, exit_price = ?, exit_timestamp = ?
          WHERE id = ?
        `, [pnl, exitPrice, Date.now(), trade.id]);
      }
      portfolio.openTrades = [];
    }
    
    // Return all bot funds to main balance
    const balances = await this.balanceManager.getBalances();
    if (balances.botBalance > 0) {
      const amount = balances.botBalance;
      await this.balanceManager.withdrawFromBot(amount);
      const portfolio = this.shadowTrader.portfolios[this.activeMode as any];
      if (portfolio) {
        portfolio.initialBalance -= amount;
        portfolio.balance -= amount;
      }
    }

    this.broadcast({ type: 'performance', data: this.shadowTrader.getPerformance() });
    this.broadcast({ type: 'balances', data: this.balanceManager.getBalances() });
    console.log('Bot Killed: All positions closed and funds returned to main balance');
  }

  setTimeframe(timeframe: string) {
    this.timeframe = timeframe;
    console.log(`Timeframe changed to ${timeframe}`);
    this.broadcast({ type: 'status', data: { timeframe } });
    if (this.isRunning) {
      this.runCycle().catch(console.error);
    }
  }

  async runCycle() {
    // 1. Fetch new candles
    let candles = [];
    try {
      candles = this.exchange ? await this.exchange.getCandles(this.symbol, this.timeframe, 200) : [];
    } catch (e) {
      console.warn(`Exchange API failed to fetch candles: ${e}`);
    }
    if (candles.length < 100) return;

    // 2. Calculate indicators
    const df = this.indicators.calculateAll(candles);
    if (df.length === 0) return;

    // 3. Detect regime
    let regimeResult;
    if (this.manualRegime) {
      regimeResult = {
        regime: this.manualRegime,
        confidence: 100,
        reasoning: "Manually set by user",
        metrics: {},
        timestamp: Date.now()
      };
    } else {
      // Fetch recent shadow performance for AI context (MD 1.3)
      const shadowPerformance = await this.shadowTrader.getPerformance();

      // Fetch latest market data and news for AI context
      const marketData = await this.marketDataService.getLatestMarketData();
      const marketNews = await this.marketDataService.getLatestNews(10);

      const marketContext = {
        btc_dominance: marketData?.btc_dominance ? `${marketData.btc_dominance.toFixed(1)}%` : "N/A",
        fear_greed_index: marketData?.fear_greed_index || "N/A",
        major_news: marketNews.length > 0 ? marketNews[0].title : "No recent major news",
        all_news: marketNews.map(n => n.title)
      };

      regimeResult = await this.regimeDetector.detect(df, this.aiSentimentAnalysis, shadowPerformance, marketContext);
    }
    
    if (this.manualRegime || this.regimeDetector.shouldUpdateRegime(this.currentRegime, regimeResult.regime, regimeResult.confidence)) {
      this.currentRegime = regimeResult.regime;
      
      // Save regime history
      await runQuery(`
        INSERT INTO regime_history (timestamp, regime, confidence, reasoning)
        VALUES (?, ?, ?, ?)
      `, [Date.now(), this.currentRegime, regimeResult.confidence, regimeResult.reasoning]);

      this.broadcast({ type: 'regime', data: regimeResult });

      if (this.aiStrategySwitching && TradingEngine.aiStrategySwitchingEnabled) {
        try {
          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey) {
            console.warn("AI Strategy Switch skipped: GEMINI_API_KEY is not set.");
          } else {
            const { GoogleGenAI } = await import('@google/genai');
            const ai = new GoogleGenAI({ apiKey });
            const prompt = `You are an expert quantitative trader. The market regime has just changed to "${this.currentRegime}" with ${regimeResult.confidence}% confidence. 
            Reasoning: ${regimeResult.reasoning}
            
            Based on this new regime, which risk mode should the trading bot switch to?
            Available modes: "ultra_conservative", "conservative", "moderate", "aggressive", "degen".
            
            Return ONLY the mode name as a plain string.`;

            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: prompt,
            });

            if (response.text) {
              const newMode = response.text.trim().toLowerCase().replace(/[^a-z_]/g, '');
              const validModes = ["ultra_conservative", "conservative", "moderate", "aggressive", "degen"];
              if (validModes.includes(newMode)) {
                this.activeMode = newMode;
                await runQuery(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['activeMode', newMode]);
                this.broadcast({ type: 'ai_mode_switch', data: { mode: newMode } });
                console.log(`AI switched strategy to ${newMode}`);
              }
            }
          }
        } catch (error: any) {
          if (error.message && error.message.includes("API_KEY_INVALID")) {
            console.error("AI Strategy Switch failed: Invalid API Key. Disabling AI features.");
            TradingEngine.aiStrategySwitchingEnabled = false;
          } else {
            console.error("AI Strategy Switch failed:", error);
          }
          // Fallback
          let newMode = 'moderate';
          if (this.currentRegime === 'strong_bull' || this.currentRegime === 'bear') {
            newMode = 'aggressive';
          } else if (this.currentRegime === 'sideways') {
            newMode = 'conservative';
          }
          this.activeMode = newMode;
          await runQuery(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['activeMode', newMode]);
          this.broadcast({ type: 'ai_mode_switch', data: { mode: newMode } });
        }
      }
    }

    // 4. Generate signal
    const signal = await this.signalGenerator.generateSignal(df, this.currentRegime, this.symbol, this.aiSignalGeneration, this.strategy);
    
    if (signal) {
      this.broadcast({ type: 'signal', data: signal });
      
      // 5. Execute shadow trades
      const currentPrice = df[df.length - 1].close;
      await this.shadowTrader.processSignal(
        signal,
        currentPrice,
        this.activeMode,
        this.balanceManager,
        this.exchange,
        this.currentRegime
      );
    }

    // 6. Update positions
    const currentPrice = df[df.length - 1].close;
    await this.shadowTrader.updatePositions(currentPrice, this.activeMode, this.balanceManager, this.exchange, df[df.length - 1]);

    // 7. Broadcast updates
    const performance = this.shadowTrader.getPerformance();
    
    this.broadcast({ type: 'performance', data: performance });
    
    const balances = this.balanceManager.getBalances();
    this.broadcast({ type: 'balances', data: balances });
    
    // Broadcast latest candle for chart
    this.broadcast({ type: 'candle', data: df[df.length - 1] });
  }

  broadcast(message: any) {
    this.wss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify(message));
      }
    });
  }

  async runBacktest(mode: string, customConfig?: any, startTime?: number, endTime?: number) {
    // Fetch candles for the period
    // If startTime/endTime are not provided, default to last 500 candles
    let candles: any[] = [];
    
    if (startTime && endTime) {
      console.log(`Running backtest from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);
      // Use getHistoricalCandles to fetch and cache data
      // Calculate how many candles we need based on timeframe
      let limit = 20000;
      if (this.timeframe === '15m') limit = Math.ceil((endTime - startTime) / (15 * 60 * 1000));
      else if (this.timeframe === '1h') limit = Math.ceil((endTime - startTime) / (60 * 60 * 1000));
      else if (this.timeframe === '1d') limit = Math.ceil((endTime - startTime) / (24 * 60 * 60 * 1000));
      
      // Cap at 100,000 candles to prevent memory issues
      limit = Math.min(limit, 100000);
      
      if (this.exchange) {
        candles = await this.exchange.getHistoricalCandles(this.symbol, this.timeframe, startTime, limit, endTime);
        console.log(`[Backtest] Fetched ${candles.length} candles from exchange`);
      } else {
        candles = [];
        console.log(`[Backtest] No exchange connector found`);
      }
      
      // Filter by endTime just in case
      candles = candles.filter(c => c.time <= endTime);
    } else {
      try {
        if (this.exchange) {
          candles = await this.exchange.getCandles(this.symbol, this.timeframe, 500);
        } else {
          candles = [];
        }
      } catch (e) {
        console.warn(`Exchange API failed to fetch candles for backtest: ${e}`);
        candles = [];
      }
    }

    if (candles.length < 100) return { trades: [], candles: [] };

    // Ensure candles are sorted and unique by time
    const uniqueCandlesMap = new Map();
    candles.forEach(c => uniqueCandlesMap.set(c.time, c));
    const sortedCandles = Array.from(uniqueCandlesMap.values()).sort((a: any, b: any) => a.time - b.time);

    const df = this.indicators.calculateAll(sortedCandles);
    const virtualTrades = [];
    const regimeChanges = [];
    let lastRegime = null;
    const config = customConfig || this.shadowTrader.riskManager.getConfig(mode as any);

    // Start from index 50 to have enough data for indicators
    for (let i = 50; i < df.length; i++) {
      const slice = df.slice(0, i + 1);
      const regimeResult = await this.regimeDetector.detect(slice, this.aiSentimentAnalysis);
      
      if (lastRegime === null) {
        lastRegime = regimeResult.regime;
        regimeChanges.push({
          time: df[i].time,
          regime: lastRegime
        });
      } else if (this.regimeDetector.shouldUpdateRegime(lastRegime, regimeResult.regime, regimeResult.confidence)) {
        regimeChanges.push({
          time: df[i].time,
          regime: regimeResult.regime
        });
        lastRegime = regimeResult.regime;
      }

      const signal = await this.signalGenerator.generateSignal(slice, lastRegime, this.symbol, this.aiSignalGeneration, this.strategy);
      
      if (signal) {
        console.log(`[Backtest] Signal generated at ${new Date(df[i].time).toISOString()}: ${signal.side} ${signal.symbol} confidence=${signal.confidence}`);
      }

      if (signal && signal.confidence >= (config.confidenceThreshold || 0)) {
        // Apply multipliers
        const riskPerUnit = Math.abs(signal.entryPrice - signal.stopLoss);
        const adjustedStopLoss = signal.side === 'buy' 
          ? signal.entryPrice - (riskPerUnit * (config.slMultiplier || 1))
          : signal.entryPrice + (riskPerUnit * (config.slMultiplier || 1));
        const adjustedTakeProfit = signal.side === 'buy'
          ? signal.entryPrice + (riskPerUnit * (config.tpMultiplier || 1))
          : signal.entryPrice - (riskPerUnit * (config.tpMultiplier || 1));

        // Simulate forward to see if it hits TP or SL
        let exitPrice = null;
        let exitTime = null;
        let pnl = 0;
        let status = 'expired';

        for (let j = i + 1; j < df.length; j++) {
          const candle = df[j];
          if (signal.side === 'buy') {
            if (candle.low <= adjustedStopLoss) {
              exitPrice = adjustedStopLoss;
              exitTime = candle.time;
              pnl = (exitPrice - signal.entryPrice) / signal.entryPrice * 100 * (config.leverage || 1);
              status = 'loss';
              break;
            }
            if (candle.high >= adjustedTakeProfit) {
              exitPrice = adjustedTakeProfit;
              exitTime = candle.time;
              pnl = (exitPrice - signal.entryPrice) / signal.entryPrice * 100 * (config.leverage || 1);
              status = 'profit';
              break;
            }
          } else {
            if (candle.high >= adjustedStopLoss) {
              exitPrice = adjustedStopLoss;
              exitTime = candle.time;
              pnl = (signal.entryPrice - exitPrice) / signal.entryPrice * 100 * (config.leverage || 1);
              status = 'loss';
              break;
            }
            if (candle.low <= adjustedTakeProfit) {
              exitPrice = adjustedTakeProfit;
              exitTime = candle.time;
              pnl = (signal.entryPrice - exitPrice) / signal.entryPrice * 100 * (config.leverage || 1);
              status = 'profit';
              break;
            }
          }
        }

        virtualTrades.push({
          ...signal,
          stopLoss: adjustedStopLoss,
          takeProfit: adjustedTakeProfit,
          exitPrice,
          exitTime,
          pnl,
          status,
          time: df[i].time
        });
        
        // Skip ahead to exit time to avoid overlapping trades in simulation
        if (exitTime) {
          const exitIndex = df.findIndex(c => c.time === exitTime);
          if (exitIndex > i) i = exitIndex;
        }
      }
    }
    return { trades: virtualTrades, candles: df, regimeChanges };
  }

  getStartupDiagnostics() {
    return {
      ...this.startupDiagnostics,
      hasExchangeInstance: Boolean(this.exchange),
      exchangeCapabilities: this.exchange?.getCapabilities() || null,
      isRunning: this.isRunning,
      symbol: this.symbol,
      timeframe: this.timeframe
    };
  }
}

let engine: TradingEngine | null = null;

export async function startTradingEngine(wss: WebSocketServer) {
  if (!engine) {
    engine = new TradingEngine(wss);
    await engine.init();
    // Start engine asynchronously
    engine.start().catch(console.error);
  }
  return engine;
}

export function getTradingEngine() {
  return engine;
}

export function getStartupDiagnostics() {
  return engine?.getStartupDiagnostics() || null;
}
