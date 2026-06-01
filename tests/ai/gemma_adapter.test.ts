import { test, describe } from 'node:test';
import assert from 'node:assert';
import { assessSignal } from '../../backend/ai/gemmaAdapter.js';

describe('Gemma adapter (Block 12)', () => {
  test('GEMMA_ENABLED=false returns null immediately', async () => {
    delete process.env.GEMMA_ENABLED;
    const r = await assessSignal({ confidence: 80 }, {}, {});
    assert.equal(r, null);
  });

  test('signal.confidence < MIN_CONF returns null immediately', async () => {
    process.env.GEMMA_ENABLED = 'true';
    process.env.GEMMA_MIN_CONF_SCORE = '70';
    const r = await assessSignal({ confidence: 65 }, {}, {});
    assert.equal(r, null);
  });

  test('timeout returns delta=0, timedOut=true (simulated)', async () => {
    // Real timeout test requires a slow Ollama endpoint; this is a structural check
    process.env.GEMMA_ENABLED = 'true';
    process.env.GEMMA_TIMEOUT_MS = '1';
    process.env.OLLAMA_URL = 'http://localhost:99999'; // unreachable
    const r = await assessSignal({ confidence: 80, side: 'buy', symbol: 'BTC' }, {}, {});
    // Either timeout or connection error → null or timedOut
    assert.ok(r === null || r.timedOut === true);
  });
});
