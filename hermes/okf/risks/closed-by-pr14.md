---
type: Risk
title: Historical risks closed by PR #14 — do not re-open
description: Nine OKF risks from the previous bundle were resolved by the merged remediation branch. Recorded so agents do not chase fixed problems.
resource: https://github.com/skenglord/Shady_Trader/pull/14
tags:
  - historical
  - closed
  - pr14
  - provenance
timestamp: 2026-07-26T00:00:00Z
---

# Purpose

The previous OKF bundle described baseline `942dc974`. PR #14 merged as `63f1ecc0` and closed the
following. Agents must **not** create tasks for these.

| Previous concept | Status | Evidence on merged main |
|---|---|---|
| `risks/committed-api-key.md` | CLOSED (tree) | `settings.json` absent; `documentation/SECURITY_ROTATION.md` present |
| `risks/tokens-in-frontend-bundle.md` | CLOSED | `src/auth/tokenStore.ts`; zero `VITE_`/`GEMINI` in `src/` and built `dist/` |
| `risks/token-in-ws-url.md` | CLOSED | first-message handshake, close code 4401 |
| `risks/monolithic-app-tsx.md` | CLOSED | `App.tsx` 3,392 → ~293 lines plus eight modules |
| `risks/mldashboard-unreachable.md` | CLOSED | rendered behind a nav button and modal |
| `risks/no-migration-state-table.md` | CLOSED | `backend/migrations/runner.ts` with `schema_migrations` |
| `risks/k8s-yaml-bugs.md` | CLOSED | selector/template labels aligned; kubeconform gate in CI |
| `risks/committed-redis-files.md` | CLOSED | `data/*.rdb` and `appendonlydir/` purged |
| `dependencies/committed-binary.md` | CLOSED | `helm.tar.gz` (16.1 MB) purged |
| `risks/high-cyclomatic-complexity.md` | PARTIAL | `runCycle` 88→9, `updatePositions` 51→14; see [backend-monolith](/risks/backend-monolith.md) |
| `risks/shallow-test-coverage.md` | PARTIAL | +67 tests, `main.ts` 69.49%→80.75%; but see [ci-red-on-main](/risks/ci-red-on-main.md) |

# Outstanding operator action

The four exposed credentials (Cerebras key, `VITE_ADMIN_TOKEN`, `VITE_TRADER_TOKEN`, `GEMINI_API_KEY`)
were removed from the tracked tree but **persist in pre-baseline git history** until a human-approved
history rewrite. Rotation is still required and is not closed by the merge.
