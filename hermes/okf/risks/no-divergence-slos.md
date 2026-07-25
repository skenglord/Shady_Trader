---
type: Risk
title: No divergence SLOs and mixed logging
description: There are no metrics or alerts for ledger-to-exchange mismatch, and console and structured logging are mixed.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/observability
tags:
  - p2
  - observability
  - unverified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-064, G-071.

# Affected code

* `backend/logging/logger.ts` — structured logger.
* `backend/observability/requestMetrics.ts` — request metrics.

# Why it matters

Divergence between internal state and exchange truth is the failure mode this whole programme exists to
prevent, and it is currently unmeasured, so it would be discovered through losses rather than alerts.

# Verification status

**UNVERIFIED** in this pass.
