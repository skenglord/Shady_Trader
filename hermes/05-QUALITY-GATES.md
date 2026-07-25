---
title: "ASTS — Quality Gates and Release Gates"
programme: ASTS-HARDENING
baseline_sha: "63f1ecc0a2a90b8035cd8773e897e0953577c523"
gates: 12
---

# Quality Gates and Release Gates

Twelve gates, QG-0 through QG-11. **All mandatory.** QG-11 is **not agent-approvable** under any
circumstance.

> ⚠ **G-076 caveat.** CI is currently **red on main** (`test` + `quality`). QG-1 and QG-2 take a green
> pipeline as their evidence source, so until Phase 0 resolves G-076, no QG-1/QG-2 claim can rest on CI —
> it must cite a local run and explicitly note the red pipeline.
> See [`risks/ci-red-on-main.md`](okf/risks/ci-red-on-main.md).

## Gate hierarchy

| Gate | Name | Agent-approvable |
|---|---|---|
| QG-0 | Specification completeness | ✅ |
| QG-1 | Build, static analysis, type safety | ✅ |
| QG-2 | Unit and property tests | ✅ |
| QG-3 | Integration and restart safety | ✅ |
| QG-4 | Accounting and risk reconciliation | ✅ |
| QG-5 | Market-data and indicator integrity | ✅ |
| QG-6 | Quantitative research integrity | ✅ (independent verifier) |
| QG-7 | Security | ✅ (independent reviewer) |
| QG-8 | Performance and capacity | ✅ |
| QG-9 | Architecture and independent review | ✅ (independent reviewer) |
| QG-10 | Shadow and paper soak | ✅ (evidence-based) |
| QG-11 | **Human live-capital approval** | ❌ **NEVER** |

---

### QG-0 — Specification completeness
Scope and prohibited scope explicit · parent dependencies linked · acceptance criteria objectively
checkable · mandatory commands listed · required artifacts named · rollback described as one operation ·
independent reviewer nominated · **cited OKF concept path(s)**.

*A task that cites an UNVERIFIED gap must include verification as its first acceptance criterion.*

### QG-1 — Build, static analysis, type safety
`npm run lint` (tsc --noEmit) exit 0 · `npm run build` exit 0 · no new `any` in trading/risk/order/fill/
position code · complexity gate passes.

### QG-2 — Unit and property tests
All unit tests pass · property tests for numeric invariants · new behaviour has tests · coverage gate
(lines ≥ 50%, branches ≥ 65%) · **no test disabled or quarantined to make a gate pass**.

### QG-3 — Integration and restart safety
Integration suite passes · **restart preserves open positions and circuit-breaker state** · fault
injection: dropped acks, delayed fills, Redis outage, DB lock, WS disconnect, process crash, duplicate
events · degraded startup is paper-only.

### QG-4 — Accounting and risk reconciliation
Ledger PnL matches exchange realised PnL within tolerance · fees and funding reconcile · **a 3× leveraged
round trip is mathematically correct** (G-004 regression) · daily loss and drawdown fire from ledger
values · **the daily-loss breaker demonstrably fires** (G-006 regression) · no order exceeds free
collateral · final risk never exceeds limits after rounding.

### QG-5 — Market-data and indicator integrity
Every feature window maps to real elapsed duration · **parallel indicators equal serial on the corpus**
(G-017/018/019 regression) · data-quality checks active · missing values excluded, never zero-substituted ·
regime returns `insufficient_history` until bootstrap.

### QG-6 — Quantitative research integrity
Deterministic replay reproducible from manifest · walk-forward with frozen holdout · **all trials
reported, not just winners** · DSR/PBO computed · cost and slippage stress applied · independently
reproduced by `qa-quant` · **no parameter promoted on published evidence alone**.

### QG-7 — Security
No secrets in tree or built artifacts · no secrets in localStorage/cookies/URLs/logs · auth positive and
negative tests · least-privilege exchange keys · withdrawals disabled · IP allowlisting · **the four
pre-baseline credentials rotated**.

*Grep-only evidence is weak except for purely textual secret removal.*

### QG-8 — Performance and capacity
Cycle latency within timeframe budget · no unbounded memory growth in soak · DB query performance under
realistic volume · WebSocket broadcast scales to expected clients.

### QG-9 — Architecture and independent review
Independent architecture review approves · no implementer approves their own work · interface changes
carry version and compatibility notes · every migration has forward and rollback tests · residual-risk
list recorded.

### QG-10 — Shadow and paper soak
Thirty-day shadow soak · zero orphaned positions · zero unprotected positions · zero duplicate intents ·
zero unresolved reconciliation mismatches · paper trading with exchange-quality data.

### QG-11 — Human live-capital approval
**Not agent-approvable.** A human owner explicitly approves each capital stage. Requires: all prior gates
passed · closure matrix complete · rollback rehearsed · explicit capital ceiling · conservative mode ·
automatic halt on reconciliation mismatch.

---

## P0 release gates — live remains NO-GO until all are true

- [ ] No internal close without confirmed exchange closure *(G-001)*
- [ ] Unknown order outcomes reconcile before retry *(G-003)*
- [ ] Live entry and shadow entry states are distinct *(G-002)*
- [ ] Final order risk calculated from live free equity *(G-005)*
- [ ] Daily loss and high-water drawdown are ledger-driven *(G-006, G-035, G-036)*
- [ ] Fees, funding and slippage included *(G-028)*
- [ ] Partial exits confirmed at the exchange *(G-014)*
- [ ] Exchange-native protection verified *(G-015)*
- [ ] Startup reconciliation completes successfully *(G-003)*
- [ ] Kill switch confirms all closes before returning funds *(G-008)*
- [ ] AI cannot increase risk or select Degen *(G-012)*
- [ ] Optimisation cannot mutate active configuration *(G-013)*
- [ ] Startup does not reset restored positions *(G-007)*
- [ ] Main balance allocation explicit and capped *(G-009)*
- [ ] Slippage and risk dependencies fail closed *(G-011, G-041, G-042)*
- [ ] **`reduceOnly` on 100% of close paths** *(G-068 — currently zero)*

## P1 quality gates

- [ ] Indicator serial/parallel parity *(G-017…G-020)*
- [ ] Timeframe-aware complete history *(G-016)*
- [ ] Exact-once candle processing *(G-025, G-026)*
- [ ] Deterministic backtest manifests *(G-046…G-048)*
- [ ] Redis/SQLite authority resolved *(G-039)*
- [ ] All core SQL integration tests pass *(G-037)*
- [ ] Strict schemas for configuration and model output *(G-038)*
- [ ] Durable exit and circuit-breaker state *(G-032, G-033)*
- [ ] Real pending-operation tracking *(G-044)*
- [ ] Reconciliation SLOs monitored *(G-071)*
- [ ] **CI green on main** *(G-076)*

## Live SLOs

| SLO | Target |
|---|---:|
| Unreconciled live positions | 0 |
| Unprotected live positions | 0 |
| Duplicate order intents | 0 |
| Ledger-to-exchange quantity divergence after reconciliation | 0 |
| Unknown order state age | < exchange timeout, then critical |
| Stale decision-market-data rate | 0 for live submissions |
| Risk decisions missing from submitted orders | 0 |
| Configuration changes without version/approval | 0 |
| Backtest reproducibility for identical manifest | 100% |

## Evidence strength

| Label | Meaning |
|---|---|
| `PASS_RUNTIME` | The exact specified behaviour was executed successfully |
| `PASS_SEMANTIC` | An equivalent check covering the same failure mode was executed |
| `PASS_STRUCTURAL` | Only parseability/shape/exports checked |
| `PASS_STATIC_GREP` | Only textual presence/absence checked |
| `PARTIAL_BLOCKED` | Could not run; no equivalent substitute available |
| `FAIL` | The check failed |

**For execution, accounting, risk, security, database, migration and deploy tasks, `PASS_STRUCTURAL` and
`PASS_STATIC_GREP` are weak evidence** and do not justify task-level pass on their own. PR #14 proved this
the hard way: schema validators passed while a Deployment selector/label mismatch and an init-order SQL
defect both survived to Final Review.

**Substitution rule:** if a criterion cannot be run exactly, a semantic substitute is allowed **only if it
checks the same failure mode**, and it must be named in the log. Otherwise → `PARTIAL_BLOCKED`.
