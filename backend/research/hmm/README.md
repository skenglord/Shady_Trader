# HMM Research Module — Isolated

**Status:** Research-only. Not imported by production code.

This module trains a Hidden Markov Model (hmmlearn) to predict regime transition
probabilities. It is groundwork for a hypothetical Phase 4.

## Important

- **Never** import anything from `backend/research/` into production code.
- The HMM output is informational only.
- No trading decisions are made based on HMM predictions.

## Files

- `regimeHMM.py` — training script (requires hmmlearn)
- `evaluate.py` — backtesting transition predictions
- `IMPORT_POLICY.md` — policy document
