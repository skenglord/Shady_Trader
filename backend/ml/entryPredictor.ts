// backend/ml/entryPredictor.ts — Block 16: ML Entry Filter (A/B Gated)
//
// ISOLATED MODULE — not wired into production signal path.
// This module provides an XGBoost-based entry filter gated by an A/B experiment.
// Signals are split 50/50 control vs treatment. After 500 trades, promotion is
// evaluated: treatment PF >= control PF + 0.10 → promote to production.
//
// Until promotion, this module is advisory-display only.

export interface EntryFilterResult {
  allowed:      boolean;
  mlScore:      number | null;
  abGroup:      'control' | 'treatment';
  reason:       string;
}

const AB_SPLIT_THRESHOLD = 0.5;
const ML_THRESHOLD = 0.55;
const MIN_TRADES_FOR_PROMOTION = 500;

export function assignABGroup(signalId: string): 'control' | 'treatment' {
  // Deterministic hash for consistent assignment
  let hash = 0;
  for (let i = 0; i < signalId.length; i++) {
    hash = ((hash << 5) - hash) + signalId.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) / 2147483647) < AB_SPLIT_THRESHOLD ? 'control' : 'treatment';
}

export function evaluateEntryFilter(
  signalId: string,
  features: Float32Array,
  modelScore: number | null // from ONNX if available
): EntryFilterResult {
  const group = assignABGroup(signalId);

  if (group === 'control') {
    return { allowed: true, mlScore: null, abGroup: 'control', reason: 'control group — no ML filter' };
  }

  if (modelScore === null) {
    return { allowed: true, mlScore: null, abGroup: 'treatment', reason: 'model unavailable — fail-open' };
  }

  const allowed = modelScore >= ML_THRESHOLD;
  return {
    allowed,
    mlScore: modelScore,
    abGroup: 'treatment',
    reason: allowed ? 'passed ML threshold' : 'below ML threshold',
  };
}

export function evaluatePromotionGate(
  controlPF: number,
  treatmentPF: number,
  treatmentTradeCount: number
): { promote: boolean; reason: string } {
  if (treatmentTradeCount < MIN_TRADES_FOR_PROMOTION) {
    return { promote: false, reason: `insufficient trades: ${treatmentTradeCount}/${MIN_TRADES_FOR_PROMOTION}` };
  }
  if (treatmentPF >= controlPF + 0.10) {
    return { promote: true, reason: `treatment PF ${treatmentPF.toFixed(2)} >= control ${controlPF.toFixed(2)} + 0.10` };
  }
  return { promote: false, reason: `treatment PF ${treatmentPF.toFixed(2)} does not meet gate` };
}
