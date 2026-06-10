import { describe, test } from 'node:test';
import assert from 'node:assert';
import { OptimizationEngine, type AiClientFactory } from '../../backend/strategy/optimization_engine.js';
import { RiskMode, DEFAULT_RISK_CONFIGS } from '../../backend/risk/manager.js';

function cloneConfigs() {
  return JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIGS));
}

describe.skip('OptimizationEngine', () => {
  test('skips when GEMINI_API_KEY is missing and always clears optimization lock', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const riskManager: any = {
      RISK_CONFIGS: cloneConfigs(),
      saveConfigs: async () => {
        throw new Error('should not save without api key');
      }
    };
    const engine = new OptimizationEngine(riskManager, { queryFn: async () => [] });
    await engine.optimize('sideways');
    assert.strictEqual((engine as any).isOptimizing, false);

    process.env.GEMINI_API_KEY = originalKey;
  });

  test('returns early when optimization is already in progress', async () => {
    const riskManager: any = {
      RISK_CONFIGS: cloneConfigs(),
      saveConfigs: async () => undefined
    };
    const engine = new OptimizationEngine(riskManager, { queryFn: async () => [] });
    (engine as any).isOptimizing = true;
    await engine.optimize('bear');
    assert.strictEqual((engine as any).isOptimizing, true);
  });

  test('applies smoothed AI recommendations and persists configs', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';

    let savedConfigs: any = null;
    const riskManager: any = {
      RISK_CONFIGS: cloneConfigs(),
      saveConfigs: async (configs: any) => {
        savedConfigs = configs;
      }
    };

    const aiClientFactory = (() => ({
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            [RiskMode.MODERATE]: { stopLoss: 3.0, takeProfit: 2.0, confidenceThreshold: 80, leverage: 2.0 }
          })
        })
      }
    })) as unknown as AiClientFactory;

    const engine = new OptimizationEngine(riskManager, {
      queryFn: async () => [],
      aiClientFactory
    });

    await engine.optimize('strongbull');
    assert.ok(savedConfigs);
    assert.ok(savedConfigs[RiskMode.MODERATE].stopLoss > riskManager.RISK_CONFIGS[RiskMode.MODERATE].stopLoss);
    assert.strictEqual((engine as any).isOptimizing, false);
    process.env.GEMINI_API_KEY = originalKey;
  });

  test('handles invalid AI JSON safely', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';

    let saveCalls = 0;
    const riskManager: any = {
      RISK_CONFIGS: cloneConfigs(),
      saveConfigs: async () => {
        saveCalls += 1;
      }
    };

    const engine = new OptimizationEngine(riskManager, {
      queryFn: async () => [],
      aiClientFactory: (() => ({
        models: {
          generateContent: async () => ({ text: '{bad_json' })
        }
      })) as unknown as AiClientFactory
    });

    await engine.optimize('weakbull');
    assert.strictEqual(saveCalls, 0);
    assert.strictEqual((engine as any).isOptimizing, false);
    process.env.GEMINI_API_KEY = originalKey;
  });
});
