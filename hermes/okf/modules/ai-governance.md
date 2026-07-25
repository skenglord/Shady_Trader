---
type: Module
title: AI integration
description: Local Ollama/Gemma-compatible model adapters for narrative validation, sentiment, signal generation and mode recommendation.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/ml
tags:
  - ai
  - governance
  - p0
  - security-relevant
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/ai/gemmaAdapter.ts` plus thirteen files under `backend/ml/` (predictor, ensemble scorer, entry
predictor, gemma adjuster, python bridge, retrain job). AI output can influence risk mode without a
deterministic policy gate.

# Files that matter

* `backend/ai/gemmaAdapter.ts` — model adapter.
* `backend/ml/gemma_adjuster.ts` — adjustment logic that can influence mode.
* `backend/ml/python_bridge.ts` — Python sidecar bridge.
* `backend/ml/retrain_job.ts` — retraining scheduler.

# Risks

* [AI holds authority over capital risk](/risks/ai-unbounded-authority.md) — G-012, G-047
