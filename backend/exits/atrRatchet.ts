// backend/exits/atrRatchet.ts — Block 11: ATR Ratchet v2
//
// Bug Fix (v6 #7): v4.1 specified ATR multipliers without calibration enforcement.
// This module logs WARN every cycle until RATCHET_CALIBRATED=true is set.

import type { VolatilityRegime, RatchetStage } from '../types/regime.js';

export interface RatchetState {
  stage:            RatchetStage;
  currentStop:      number;
  rawStop:          number;
  runningExtreme:   number;
  unrealisedR:      number;
  partialExitFired: boolean;
  volRegime:        VolatilityRegime;
  atrMultiplier:    number;
}

export interface RatchetConfig {
  entry:            number;
  initialStop:      number;
  side:             'buy' | 'sell';
  stage1TriggerR?:  number;
  stage2TriggerR?:  number;
  partialFraction?: number;
  slippageFrac?:    number;
}

const ATR_MULT: Record<VolatilityRegime, number> = { low: 2.5, normal: 2.0, high: 1.5 };
const CALIBRATED = process.env.RATCHET_CALIBRATED === 'true';

export function updateRatchet(
  prev:   RatchetState | null,
  config: RatchetConfig,
  high:   number,
  low:    number,
  atr:    number,
  volReg: VolatilityRegime = 'normal'
): { state: RatchetState; partialExit: { fraction: number; price: number } | null } {
  if (!CALIBRATED) {
    console.warn('[ratchet] CALIBRATION_REQUIRED — ATR multipliers are starting estimates. ' +
      'Set RATCHET_CALIBRATED=true after running: npm run backtest -- --calibrate-ratchet');
  }

  const {
    entry, initialStop, side,
    stage1TriggerR = 1.0, stage2TriggerR = 1.5,
    partialFraction = 0.5, slippageFrac = 0,
  } = config;

  const risk = Math.abs(entry - initialStop);
  if (risk <= 0) throw new Error('RatchetConfig: initialStop must differ from entry');

  const mult = ATR_MULT[volReg];
  const ref  = side === 'buy' ? high : low;
  const unrealisedR = side === 'buy' ? (ref - entry) / risk : (entry - ref) / risk;

  const extreme = prev
    ? (side === 'buy' ? Math.max(prev.runningExtreme, high) : Math.min(prev.runningExtreme, low))
    : (side === 'buy' ? low : high);

  let stage: RatchetStage = prev?.stage ?? 0;
  if (unrealisedR >= stage2TriggerR && stage < 2) stage = 2;
  else if (unrealisedR >= stage1TriggerR && stage < 1) stage = 1;

  let rawStop: number;
  switch (stage) {
    case 0: rawStop = initialStop; break;
    case 1: rawStop = side === 'buy'
      ? Math.max(entry, prev?.rawStop ?? initialStop)
      : Math.min(entry, prev?.rawStop ?? initialStop);
      break;
    case 2: {
      const trail = side === 'buy' ? extreme - mult * atr : extreme + mult * atr;
      rawStop = side === 'buy'
        ? Math.max(trail, prev?.rawStop ?? entry, entry)
        : Math.min(trail, prev?.rawStop ?? entry, entry);
      break;
    }
  }

  const currentStop = slippageFrac > 0
    ? (side === 'buy' ? rawStop * (1 - slippageFrac) : rawStop * (1 + slippageFrac))
    : rawStop;

  const newStage1 = stage === 1 && (prev?.stage ?? 0) === 0;
  const partialExit = newStage1 && !(prev?.partialExitFired)
    ? { fraction: partialFraction, price: ref }
    : null;

  return {
    state: {
      stage, currentStop, rawStop, runningExtreme: extreme,
      unrealisedR, volRegime: volReg, atrMultiplier: mult,
      partialExitFired: (prev?.partialExitFired ?? false) || partialExit !== null,
    },
    partialExit,
  };
}

export function isRatchetStopHit(state: RatchetState, side: 'buy' | 'sell',
  low: number, high: number): boolean {
  return side === 'buy' ? low <= state.currentStop : high >= state.currentStop;
}

export const STAGE_LABELS: Record<RatchetStage, string> = {
  0: 'Initial Stop', 1: 'Break-Even + Partial', 2: 'ATR Trail',
};
