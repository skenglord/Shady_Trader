---
type: Module
title: Freqtrade bridge
description: Python Freqtrade sidecar integration: bridge, validation and backtest/data/validate workers.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/freqtrade
tags:
  - freqtrade
  - python
  - sidecar
  - integration
timestamp: 2026-07-26T00:00:00Z
---

# Overview

Fifteen files under `backend/freqtrade/`, headlined by `bridge.ts` (33.2 KB). Requires a Python venv;
four tests are environmental and skip without it (PR #14 made those paths repo-relative).

# Files that matter

* `backend/freqtrade/bridge.ts` — sidecar bridge and env handling.
* `backend/freqtrade/validation.ts` — payload validation.
* `backend/freqtrade/workers/` — backtest, data and validate workers.
