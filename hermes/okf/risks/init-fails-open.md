---
type: Risk
title: Initialisation and dependency failures fail open
description: Risk initialisation errors are logged at warn level and Redis failure starts the engine in a live-capable mode.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts#L562-L567
tags:
  - p1
  - fail-closed
  - startup
  - security-relevant
  - verified
  - root-cause
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-041, G-042.

# Affected code

* `backend/main.ts:562-567` — `shadowTrader.init()` / `riskManager.init()` failures caught at warn.
* `server.ts:195-197` — Redis failure leaves `redis = null`.
* `server.ts:384` — `startTradingEngine(wss, null)`.
* `backend/main.ts:109` — default `_activeMode = 'moderate'` (live-capable).

# Why it matters

The system continues into a live-capable state precisely when the components that constrain risk failed to
initialise. A degraded start should be paper-only and explicitly disarmed, not silently permissive.

# Verification status

**CONFIRMED** — only the Degen-specific `validateModeForLive` guard throws; all other init failures
proceed.
