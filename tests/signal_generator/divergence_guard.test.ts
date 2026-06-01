import { test, describe } from 'node:test';
import assert from 'node:assert';
import { checkDivergenceBlock, CONF_THRESHOLD, CONF_THRESHOLD_HIGH } from '../../backend/strategy/signal_generator.js';

describe('Divergence guard (Block 5)', () => {
  test('blocks BUY on WT bearish divergence', () => {
    const r = checkDivergenceBlock({ wt_bear_div: true, mfi_bear_div: false }, 'buy');
    assert.equal(r.blocked, true);
    assert.match(r.reason, /WT bearish divergence/);
  });

  test('blocks BUY on MFI bearish divergence', () => {
    const r = checkDivergenceBlock({ wt_bear_div: false, mfi_bear_div: true }, 'buy');
    assert.equal(r.blocked, true);
  });

  test('blocks SELL on WT bullish divergence', () => {
    const r = checkDivergenceBlock({ wt_bull_div: true }, 'sell');
    assert.equal(r.blocked, true);
  });

  test('does not block clean BUY setup', () => {
    const r = checkDivergenceBlock(
      { wt_bear_div: false, mfi_bear_div: false, wt_bull_div: false, mfi_bull_div: false }, 'buy');
    assert.equal(r.blocked, false);
  });

  test('confidence thresholds recalibrated (72/82)', () => {
    assert.equal(CONF_THRESHOLD, 72);
    assert.equal(CONF_THRESHOLD_HIGH, 82);
  });
});
