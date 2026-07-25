---
type: Risk
title: Exchange key policy and route authentication are unproven
description: Withdrawal restrictions, IP allowlisting and least-privilege API keys are not demonstrated, and paper WebSocket routing used substring matching.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/api/routes.ts
tags:
  - p2
  - security-relevant
  - operational
  - unverified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-066, G-067.

# Affected code

* `backend/api/routes.ts` — privileged route surface.
* `backend/api/websocket.ts` — route handling and auth.

# Why it matters

An exchange key with withdrawal permission converts any application compromise into direct fund loss, so
key scope must be asserted at startup rather than assumed. PR #14 materially improved transport auth, but
key policy remains unverified.

# Verification status

**UNVERIFIED** in this pass. Partially improved by PR #14.
