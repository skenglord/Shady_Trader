---
type: Risk
title: Kill path clears internal state without confirming exchange closure
description: The kill switch can clear positions and return funds even when live closes fail.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts
tags:
  - p0
  - kill-switch
  - money-path
  - unverified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-008.

# Affected code

* `backend/main.ts` — kill-switch handling within the composition root.

# Why it matters

If the kill path is the operator's emergency control, it must be the most trustworthy path in the system.
Clearing internal state while exchange closes fail converts an emergency stop into an unmanaged-exposure
event.

# Verification status

**UNVERIFIED** — not individually anchored in this pass. Given the confirmed pattern in
[exchange-as-side-effect](/risks/exchange-as-side-effect.md), treat as likely and verify before closing.
<!-- TODO: verify exact kill-path line range -->
