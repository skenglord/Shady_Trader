// backend/ai/gemmaAdapter.ts — Block 12: Non-blocking Gemma with fail-open

import { logger } from '../logging/logger.js';

const TIMEOUT_MS = parseInt(process.env.GEMMA_TIMEOUT_MS ?? '2000');
const MIN_CONF   = parseInt(process.env.GEMMA_MIN_CONF_SCORE ?? '70');
const ENABLED    = process.env.GEMMA_ENABLED === 'true';

export interface GemmaAdjustment {
  delta:    number;
  reason:   string;
  timedOut: boolean;
}

export async function assessSignal(
  signal: any,
  data: any,
  rrRsi: any
): Promise<GemmaAdjustment | null> {
  if (!ENABLED || signal.confidence < MIN_CONF) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const prompt = `Assess trade: ${signal.side} ${signal.symbol} conf=${signal.confidence}`;
    const resp = await fetch(`${process.env.OLLAMA_URL ?? 'http://localhost:11434'}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL ?? 'gemma4',
        prompt,
        stream: false,
      }),
    });

    const json = await resp.json();
    const text = (json.response ?? '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);

    return {
      delta:    parsed.confirmed ? 0.10 : -0.30,
      reason:   parsed.reasoning ?? '',
      timedOut: false,
    };
  } catch (e: any) {
    if (e.name === 'AbortError') {
      logger.warn('Gemma timeout — proceeding rule-based', { service: 'gemmaAdapter' });
      return { delta: 0, reason: 'timeout', timedOut: true };
    }
    logger.error('Gemma error', { service: 'gemmaAdapter', error: e.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
