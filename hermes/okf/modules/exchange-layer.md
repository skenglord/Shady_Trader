---
type: Module
title: Exchange Layer
description: Exchange adapters and connectors for Binance, Bybit, OKX, Kraken and Coinbase Advanced, plus reconciliation, pooling, backpressure and rotation.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/exchange
tags:
  - exchange
  - integration
  - reconciliation
  - p0
timestamp: 2026-07-26T00:00:00Z
---

# Overview

Thirteen files under `backend/exchange/`. `connector.ts` (52.9 KB) is the largest. A
`PositionReconciliationEngine` exists and is instantiated by the connector, but no reconciliation is
wired into the engine lifecycle — `backend/main.ts` contains zero `reconcil*` references.

# Files that matter

* `backend/exchange/reconciliation.ts:15` — `PositionReconciliationEngine` class definition.
* `backend/exchange/connector.ts:109` — the only instantiation.
* `backend/exchange/connector.ts:407-408, 584, 665, 693` — timeframe→ms map duplicated four times.
* `backend/exchange/adapter.ts` — order placement surface used by the shadow trader.
* `backend/exchange/provider-rotator.ts` — market-data provider rotation.

# Risks

* [No authoritative reconciliation loop](/risks/no-reconciliation-loop.md) — G-003
* [No reduce-only or exchange-native protection](/risks/exchange-as-side-effect.md) — G-014, G-015, G-068
* [No timeframe registry](/risks/no-timeframe-registry.md) — G-024
