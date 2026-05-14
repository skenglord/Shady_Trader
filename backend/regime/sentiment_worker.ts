import { z } from 'zod';
import OpenAI from 'openai';
import Redis from 'ioredis';

const SENTIMENT_SYSTEM_PROMPT = `You are a news sentiment classifier for crypto markets.
Score each headline from -1.0 (extreme bearish) to 1.0 (extreme bullish).
Return ONLY a JSON array. No other text. No markdown.`;

const SENTIMENT_USER_PROMPT = (headlines: string[]) =>
`Score these ${headlines.length} crypto news headlines:
${headlines.map((h, i) => `${i}: "${h}"`).join('\n')}

Return JSON array of numbers only, same length as input:
[0.3, -0.7, 0.1, ...]`;

export class SentimentWorker {
  private ai: OpenAI;
  private redis: Redis;

  constructor(redis: Redis, apiKey: string = 'ollama', baseURL: string = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1') {
    this.ai = new OpenAI({ apiKey, baseURL });
    this.redis = redis;
  }

  private parseSentimentResponse(raw: string): number[] | null {
    let text = raw.replace(/```(?:json)?/g, '').trim();
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    if (!arrayMatch) return null;
    
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (!Array.isArray(parsed)) return null;
      
      return parsed.map(v => {
        const n = parseFloat(String(v));
        if (isNaN(n)) return 0.0;
        return Math.max(-1.0, Math.min(1.0, n));
      });
    } catch {
      return null;
    }
  }

  async fetchRecentHeadlines(count: number): Promise<string[]> {
    // Stub for fetching real headlines
    return ["Bitcoin hits new high", "Regulatory concerns loom", "ETF inflows surge"];
  }

  async refreshLoop() {
    while (true) {
      try {
        const headlines = await this.fetchRecentHeadlines(20);
        const response = await this.ai.chat.completions.create({
          model: 'gemma:2b',
          messages: [
            { role: 'system', content: SENTIMENT_SYSTEM_PROMPT },
            { role: 'user', content: SENTIMENT_USER_PROMPT(headlines) }
          ],
          temperature: 0.1,
        });

        const raw = response.choices[0]?.message?.content || '[]';
        const parsed = this.parseSentimentResponse(raw);
        
        if (parsed && parsed.length > 0) {
          const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
          await this.redis.setex('sentiment:score:latest', 300, avg.toFixed(4));
        }
      } catch (e) {
        console.warn('Sentiment refresh failed', e);
      }
      
      // 5 minute wait
      await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
    }
  }
}
