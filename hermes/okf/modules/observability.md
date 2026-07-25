---
type: Module
title: Observability and logging
description: Structured logging with rotation, request metrics and Freqtrade metrics.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/observability
tags:
  - observability
  - logging
  - p2
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/logging/logger.ts` and `rotation.ts`, plus `backend/observability/requestMetrics.ts` and
`freqtrade_metrics.ts`. Good intent, but no divergence SLOs and mixed console/structured logging remain.

# Files that matter

* `backend/logging/logger.ts` — structured logger.
* `backend/observability/requestMetrics.ts` — Prometheus-style request metrics.

# Risks

* [No divergence SLOs or unified logging](/risks/no-divergence-slos.md) — G-064, G-071
