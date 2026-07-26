---
type: Risk
title: Shutdown does not track in-flight operations
description: waitForPendingOperations sleeps instead of tracking work, and there is no live-position handoff policy.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts#L414-L422
tags:
  - p1
  - shutdown
  - reliability
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-044, G-045.

# Affected code

* `backend/main.ts:414-422` — the function contains the comment "In a real implementation, we would track
  pending operations" and only sleeps.

# Why it matters

Graceful shutdown is what prevents a deploy or restart from interrupting an in-flight order or database
write, and a fixed sleep provides no such guarantee. There is also no defined policy for what happens to
open live positions when the process stops.

# Verification status

**CONFIRMED** — the source comment is explicit.
