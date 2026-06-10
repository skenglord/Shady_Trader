// backend/types/regime.ts
// Single source of truth for all regime-related types.
// Every file in the codebase that references a regime string imports from here.
// This file intentionally has no imports — it must be dependency-free.

export type CompositeRegime =
  | 'strongbull'   // up + strong + any vol
  | 'weakbull'     // up + moderate + normal/low vol
  | 'bear'         // down + any strength + any vol (see Block 4 bug fix)
  | 'sideways'     // flat or up+weak
  | 'uncertain';   // high vol + transitioning

export type VolatilityRegime = 'low' | 'normal' | 'high';
export type TrendDirection   = 'up'  | 'down'   | 'flat';
export type TrendStrength    = 'strong' | 'moderate' | 'weak';
export type RatchetStage     = 0 | 1 | 2;

// Canonical set — use for validation
export const COMPOSITE_REGIMES = new Set<CompositeRegime>([
  'strongbull', 'weakbull', 'bear', 'sideways', 'uncertain'
]);

export function isCanonicalRegime(s: string): s is CompositeRegime {
  return COMPOSITE_REGIMES.has(s as CompositeRegime);
}

// Mapping from underscore format (legacy) to canonical
export const LEGACY_TO_CANONICAL: Record<string, CompositeRegime> = {
  'strong_bull': 'strongbull',
  'weak_bull': 'weakbull',
  'strongbull': 'strongbull',
  'weakbull': 'weakbull',
  'bear': 'bear',
  'sideways': 'sideways',
  'uncertain': 'uncertain',
};

export function normalizeRegime(s: string): CompositeRegime {
  return LEGACY_TO_CANONICAL[s] ?? 'uncertain';
}
