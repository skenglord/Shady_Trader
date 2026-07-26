---
type: Risk
title: backend/main.ts remains an orchestration monolith
description: The composition root still mixes dependency construction, scheduling, persistence, AI policy, kill-switch behaviour and broadcasting.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts
tags:
  - p2
  - maintainability
  - architecture
  - partially-closed
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-062, G-063.

# Affected code

* `backend/main.ts` — 58.9 KB composition root.
* `backend/api/routes.ts` — 73.2 KB, the largest single file in the repo.

# Why it matters

Concentrating unrelated responsibilities in one file makes safety properties hard to prove and forces
multiple agents to edit the same file, which is the main source of merge conflict in a parallel agent
programme.

# Verification status

**PARTIALLY CLOSED.** PR #14 reduced `runCycle()` complexity from ~88 to 9 via eleven stage methods, and
resolved the frontend monolith entirely. The backend file-level monolith remains.
