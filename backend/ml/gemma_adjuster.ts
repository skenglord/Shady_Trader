import { z } from 'zod';
import { logger } from '../logging/logger.js';

const CACHE_KEY = 'ml:gemma:adjustment';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_MS = 4 * 60 * 1000;

interface CachedAdjustment {
  adjustment: number;
  reason: string;
  cachedAt: number;
}

let cachedAdjustment: CachedAdjustment | null = null;

const GemmaAdjustmentSchema = z.object({
  adjustment: z.number().min(-0.4).max(0.4),
  reason: z.string().max(200)
});

type GemmaAdjustmentOutput = z.infer<typeof GemmaAdjustmentSchema>;

function buildMetaLabelPrompt(
  xgbProbability: number,
  topFeatures: [string, number][],
  newsContext: string,
  regime: string,
  cachedSentimentScore: number
): string {
  const featStr = topFeatures
    .map(([name, val]) => `${name.replace(/_/g, ' ')}(${val.toFixed(3)})`)
    .join(', ');

  return `A quantitative model outputs ${(xgbProbability * 100).toFixed(1)}% probability of green candle close.
Primary technical drivers: ${featStr}.
Current market regime: ${regime}.
Macro sentiment score: ${cachedSentimentScore.toFixed(2)} (range -1=bearish to +1=bullish).
Recent news context: ${newsContext.slice(0, 400)}

Does the news STRENGTHEN or WEAKEN the quantitative prediction?
Output ONLY valid JSON, no other text:
{
  "adjustment": 0.0,
  "reason": "max 15 words"
}
adjustment must be a float between -0.4 and 0.4.
Negative = news contradicts model. Positive = news confirms. Zero = irrelevant.`;
}

async function callGemmaWithRetry(
  systemPrompt: string,
  userPrompt: string,
  maxRetries = 2,
  timeoutMs = 4000
): Promise<GemmaAdjustmentOutput | null> {
  const ollamaUrl = process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL ?? 'gemma4:2b',
          system: systemPrompt,
          prompt: userPrompt,
          stream: false,
          temperature: 0.1,
          format: 'json'
        })
      });

      clearTimeout(timer);

      const raw = await response.json();
      const text = (raw.response as string ?? '').trim();

      const cleaned = text.replace(/```(?:json)?/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        logger.warn(`[gemma_adjuster] No JSON in response (attempt ${attempt}): ${text.slice(0, 100)}`);
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const result = GemmaAdjustmentSchema.safeParse(parsed);

      if (result.success) return result.data;
      logger.warn('[gemma_adjuster] Zod validation failed:', result.error.issues);

    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        logger.warn(`[gemma_adjuster] Timeout on attempt ${attempt}`);
      } else {
        logger.warn('[gemma_adjuster] Call failed:', err);
      }
    }
  }

  return null;
}

export interface MetaLabelContext {
  xgbProbability: number;
  topFeatures: [string, number][];
  newsContext: string;
  regime: string;
  cachedSentimentScore: number;
}

let refreshLoopRunning = false;

export function startGemmaAdjusterLoop(
  getLatestContext: () => MetaLabelContext | null
): void {
  if (refreshLoopRunning) return;
  refreshLoopRunning = true;

  const SYSTEM_PROMPT = `You are a meta-labeling model for a quantitative trading system.
You receive a quantitative probability and news context.
Your only job is to output a small adjustment scalar as JSON.
Output ONLY valid JSON. No markdown. No explanation outside the JSON object.`;

  const loop = async () => {
    while (refreshLoopRunning) {
      try {
        const ctx = getLatestContext();

        if (ctx) {
          const userPrompt = buildMetaLabelPrompt(
            ctx.xgbProbability,
            ctx.topFeatures,
            ctx.newsContext,
            ctx.regime,
            ctx.cachedSentimentScore
          );

          const result = await callGemmaWithRetry(SYSTEM_PROMPT, userPrompt);

          if (result) {
            cachedAdjustment = {
              adjustment: result.adjustment,
              reason: result.reason,
              cachedAt: Date.now()
            };
            logger.debug(`[gemma_adjuster] Cached adjustment: ${result.adjustment} — ${result.reason}`);
          }
        }
      } catch (err) {
        logger.error('[gemma_adjuster] Loop error:', err);
      }

      await new Promise(r => setTimeout(r, REFRESH_MS));
    }
  };

  loop().catch(e => logger.error('[gemma_adjuster] Fatal loop error:', e));
}

export async function getCachedAdjustment(): Promise<number> {
  if (!cachedAdjustment) return 0.0;
  if (Date.now() - cachedAdjustment.cachedAt > CACHE_TTL_MS) return 0.0;

  try {
    const val = Number(cachedAdjustment.adjustment);
    return isNaN(val) ? 0.0 : Math.max(-0.4, Math.min(0.4, val));
  } catch {
    return 0.0;
  }
}

export function stopGemmaAdjusterLoop(): void {
  refreshLoopRunning = false;
}

export function getGemmaHealth() {
  return {
    running: refreshLoopRunning,
    hasCachedValue: cachedAdjustment !== null,
    cachedAt: cachedAdjustment?.cachedAt ?? null
  };
}