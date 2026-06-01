import { test, describe } from 'node:test';
import assert from 'node:assert';
import { updateRatchet, isRatchetStopHit, STAGE_LABELS } from '../../backend/exits/atrRatchet.js';

describe('ATR Ratchet (Block 11)', () => {
  test('stage advances 0→1 at 1.0R, 1→2 at 1.5R', () => {
    const cfg = { entry: 100, initialStop: 98, side: 'buy' as const };
    const r0 = updateRatchet(null, cfg, 100, 99, 0.5);
    assert.equal(r0.state.stage, 0);

    const r1 = updateRatchet(r0.state, cfg, 102, 100, 0.5); // 1.0R
    assert.equal(r1.state.stage, 1);

    const r2 = updateRatchet(r1.state, cfg, 103, 100, 0.5); // 1.5R
    assert.equal(r2.state.stage, 2);
  });

  test('stage never retreats', () => {
    const cfg = { entry: 100, initialStop: 98, side: 'buy' as const };
    const r2 = updateRatchet(null, cfg, 103, 100, 0.5);
    const r2b = updateRatchet({ ...r2.state, stage: 2 }, cfg, 100, 99, 0.5); // R drops
    assert.equal(r2b.state.stage, 2);
  });

  test('partialExit fires exactly once at 0→1 transition', () => {
    const cfg = { entry: 100, initialStop: 98, side: 'buy' as const };
    const r0 = updateRatchet(null, cfg, 100, 99, 0.5);
    assert.equal(r0.partialExit, null);

    const r1 = updateRatchet(r0.state, cfg, 102, 100, 0.5);
    assert.ok(r1.partialExit);
    assert.equal(r1.partialExit!.fraction, 0.5);

    const r1b = updateRatchet(r1.state, cfg, 102.5, 100, 0.5);
    assert.equal(r1b.partialExit, null);
  });

  test('isRatchetStopHit returns true when candle low <= stop for longs', () => {
    const state = { currentStop: 99, stage: 1 } as any;
    assert.equal(isRatchetStopHit(state, 'buy', 98, 100), true);
    assert.equal(isRatchetStopHit(state, 'buy', 99.5, 100), false);
  });

  test('STAGE_LABELS defined', () => {
    assert.equal(STAGE_LABELS[0], 'Initial Stop');
    assert.equal(STAGE_LABELS[2], 'ATR Trail');
  });
});
