import { runQuery } from '../database.js';
import { RiskMode, RiskManager } from '../risk/manager.js';
import { GoogleGenAI, Type } from '@google/genai';

type QueryFn = (query: string, params?: any[], mode?: 'all' | 'get' | 'run') => Promise<any>;
type AiClientFactory = (apiKey: string) => {
  models: {
    generateContent: (input: any) => Promise<{ text?: string | null }>;
  };
};

export class OptimizationEngine {
  private riskManager: RiskManager;
  private isOptimizing: boolean = false;
  private queryFn: QueryFn;
  private aiClientFactory: AiClientFactory;

  constructor(
    riskManager: RiskManager,
    deps: {
      queryFn?: QueryFn;
      aiClientFactory?: AiClientFactory;
    } = {}
  ) {
    this.riskManager = riskManager;
    this.queryFn = deps.queryFn || runQuery;
    this.aiClientFactory = deps.aiClientFactory || ((apiKey: string) => new GoogleGenAI({ apiKey }) as any);
  }

  async optimize(regime: string) {
    if (this.isOptimizing) return;
    this.isOptimizing = true;
    console.log(`Starting auto-optimization for regime: ${regime}`);

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.warn("Auto-optimization skipped: GEMINI_API_KEY is not set.");
        return;
      }

      // 1. Fetch recent trade performance (last 7 days)
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentTrades = await this.queryFn(`
        SELECT * FROM shadow_trades
        WHERE timestamp > ? AND status = 'closed'
        ORDER BY timestamp DESC
      `, [sevenDaysAgo], 'all');

      // 2. Fetch daily performance metrics
      const performanceMetrics = await this.queryFn(`
        SELECT * FROM daily_performance
        ORDER BY date DESC LIMIT 30
      `, [], 'all');

      const currentConfigs = this.riskManager.RISK_CONFIGS;

      // 3. Use Gemini to analyze performance and recommend adjustments
      const ai = this.aiClientFactory(apiKey);
      const prompt = `You are an expert quantitative trading systems optimizer.
Current Market Regime: ${regime}
Recent Trades (last 7 days): ${JSON.stringify(recentTrades.slice(0, 50))}
Historical Performance: ${JSON.stringify(performanceMetrics)}
Current Risk Configurations: ${JSON.stringify(currentConfigs)}

Task:
Analyze the trading performance across all risk modes in the current market regime.
Identify which parameters (stopLoss, takeProfit, leverage, confidenceThreshold) are underperforming and recommend adjustments to optimize for the NEXT 15 minutes.
Be specific. If a mode is losing too much, tighten stop losses or raise confidence thresholds. If it's missing out on trends, potentially widen take profits.

Return the updated configurations for ALL modes in JSON format.`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              ultra_conservative: { type: Type.OBJECT, properties: { stopLoss: { type: Type.NUMBER }, takeProfit: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
              conservative: { type: Type.OBJECT, properties: { stopLoss: { type: Type.NUMBER }, takeProfit: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
              moderate: { type: Type.OBJECT, properties: { stopLoss: { type: Type.NUMBER }, takeProfit: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
              aggressive: { type: Type.OBJECT, properties: { stopLoss: { type: Type.NUMBER }, takeProfit: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } },
              degen: { type: Type.OBJECT, properties: { stopLoss: { type: Type.NUMBER }, takeProfit: { type: Type.NUMBER }, confidenceThreshold: { type: Type.NUMBER }, leverage: { type: Type.NUMBER } } }
            }
          }
        }
      });

      if (response.text) {
        let recommendations: any = null;
        try {
          recommendations = JSON.parse(response.text);
        } catch (e) {
          console.error("Auto-optimization returned invalid JSON:", response.text);
          return;
        }
        const newConfigs = JSON.parse(JSON.stringify(currentConfigs));

        for (const mode of Object.keys(recommendations)) {
          if (newConfigs[mode]) {
            // Apply smoothing: 80% new, 20% old as per MD
            for (const [key, val] of Object.entries(recommendations[mode])) {
              const currentVal = newConfigs[mode][key];
              if (typeof currentVal === 'number' && typeof val === 'number') {
                newConfigs[mode][key] = Number((val * 0.8 + currentVal * 0.2).toFixed(4));
              }
            }
          }
        }

        await this.riskManager.saveConfigs(newConfigs);
        console.log("Auto-optimization complete. New configs saved.");
      }
    } catch (error) {
      console.error("Auto-optimization failed:", error);
    } finally {
      this.isOptimizing = false;
    }
  }
}
