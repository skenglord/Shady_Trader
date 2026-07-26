---
type: Module
title: Optimisation and Monte Carlo
description: Bayesian optimiser, trial history, Monte Carlo engine, stress testing, correlation and risk calculators.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/monte-carlo
tags:
  - optimisation
  - research
  - governance
  - p0
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/optimization/` plus ten files under `backend/monte-carlo/` (engine, risk calculator, stress-test
engine, correlation matrix, path generator, controller, websocket). Candidate settings can reach active
configuration without passing validation.

# Files that matter

* `backend/optimization/` — Bayesian optimiser and trial persistence.
* `backend/monte-carlo/engine/monte-carlo-engine.ts` — simulation engine.
* `backend/monte-carlo/engine/stress-test-engine.ts` — stress scenarios.
* `backend/monte-carlo/api/monte-carlo.controller.ts` — request validation and API surface.

# Risks

* [Optimiser can mutate production configuration](/risks/optimiser-unbounded-authority.md) — G-013, G-049, G-050, G-051, G-052
