---
type: Dependency
title: Python sidecars
description: Freqtrade sidecar and the ML Python bridge, both requiring a local virtual environment.
resource: https://www.freqtrade.io/en/stable/
tags:
  - python
  - sidecar
  - freqtrade
  - ml
timestamp: 2026-07-26T00:00:00Z
---

# Concern

`backend/freqtrade/` and `backend/ml/python_bridge.ts` shell out to Python. Four Freqtrade tests are
environmental and skip without a venv; PR #14 made those paths repo-relative rather than hard-coded to a
developer home directory. Any CI or container image must provision the venv or these paths stay untested.
