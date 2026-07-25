---
title: "ASTS Hermes Hardening Programme — Root Index"
programme: ASTS-HARDENING
baseline_sha: "63f1ecc0a2a90b8035cd8773e897e0953577c523"
status: "Verified against source; ready for Hermes decomposition"
live_status: "NO-GO until all P0 and quantitative release gates pass"
---

# ASTS Hermes Hardening Programme

This directory is the **single source of truth** for the AI Shadow Trading System hardening programme.
It replaces the monolithic `enterprise_crypto_trading_bot_agentic_hardening_v3_complete.md` (3,507 lines),
decomposed into focused documents so a coding agent loads only what its task needs.

> **Live-trading status: NO-GO.** No agent may enable live order submission, raise AI authority over risk,
> or promote optimiser output to production configuration. QG-11 (human live-capital approval) is not
> agent-approvable under any circumstance.

## Baseline

| Field | Value |
|---|---|
| Repository | `skenglord/Shady_Trader` |
| **Baseline SHA** | `63f1ecc0a2a90b8035cd8773e897e0953577c523` |
| Baseline established | PR #14 merged 2026-07-25 (13 remediation tasks) |
| Previous baseline | `942dc974…` — **superseded, do not use** |

Every anchor in these documents was read from source at this baseline. If you are working from a later
commit, re-verify anchors before editing; line numbers drift.

## Reading order

| # | Document | Read when |
|---|---|---|
| **00** | `00-INDEX.md` (this file) | First, always |
| **01** | [`01-SYSTEM-OVERVIEW.md`](01-SYSTEM-OVERVIEW.md) | You need current + target architecture |
| **02** | [`02-GAP-REGISTER.md`](02-GAP-REGISTER.md) | You need the verified defect list and anchors |
| **03** | [`03-COMPONENT-FINDINGS.md`](03-COMPONENT-FINDINGS.md) | You own a specific component |
| **04** | [`04-IMPLEMENTATION-PLAN.md`](04-IMPLEMENTATION-PLAN.md) | You need phase ordering and exit criteria |
| **05** | [`05-QUALITY-GATES.md`](05-QUALITY-GATES.md) | Before claiming any task complete |
| **06** | [`06-HERMES-OPERATING-MODEL.md`](06-HERMES-OPERATING-MODEL.md) | You are the orchestrator, or need write scopes |
| **07** | [`07-TRADING-MATHEMATICS.md`](07-TRADING-MATHEMATICS.md) | You touch sizing, risk or PnL formulas |
| **08** | [`08-QUANT-PROTOCOL.md`](08-QUANT-PROTOCOL.md) | You run or verify research |
| **09** | [`09-EPICS-AND-RUNBOOK.md`](09-EPICS-AND-RUNBOOK.md) | You are sequencing or starting the programme |
| **10** | [`10-OKF-GUIDE.md`](10-OKF-GUIDE.md) | Before reading or updating the knowledge bundle |
| — | [`okf/`](okf/index.md) | The knowledge bundle itself |

## The OKF bundle is the knowledge layer

[`okf/`](okf/index.md) is a conformant Open Knowledge Format v0.1 bundle: **20 Modules, 28 Risks,
5 Dependencies**. Every phase and epic in these documents cites the OKF concept paths it touches.

**Read the concept before you edit the code.** A concept gives you the file:line anchors, the verified
evidence, the related risks and the gap IDs in one place. See [`10-OKF-GUIDE.md`](10-OKF-GUIDE.md).

## Verification status — read this before trusting any finding

The original register listed 75 gaps derived from **screenshots, not a repository audit**. This programme
re-verified them against source:

| Status | Count | Meaning |
|---|---:|---|
| **CONFIRMED** | 33 | Read from source; exact anchor recorded |
| **PARTIAL** | 2 | Real but differently shaped than described |
| **UNVERIFIED** | 41 | Plausible, not individually anchored — **verify before editing** |
| **Refuted** | 0 | Nothing was found to be fabricated |
| **New** | 1 | G-076, CI red on main — found during verification |

Two P0s (G-001, G-004) and one P1 (G-037) are **more severe** than originally described.

> **Rule for every agent:** if your task cites an UNVERIFIED gap, your first action is to verify it and
> record the real anchor. If the defect does not exist, block the task with `clarification-required:` —
> do **not** invent a fix for a problem that is not there.

## Orchestration boundary

Two orchestration systems exist. They must not overlap.

* **Hermes Kanban owns implementation** — decomposition, routing, review, verification, release. All
  execution work for this programme runs through the Hermes board.
* **The Hyperagent repo-triage pipeline owns the knowledge layer** — it produced the OKF bundle and this
  analysis. It is **not** invoked for ASTS execution.

Single writer rule: only Hermes agents write code during this programme.

## Non-negotiable constraints

1. **No live trading.** Live submission stays disarmed; `liveArmed=false` is a startup invariant.
2. **No AI risk authority.** AI output is advisory; Degen is never auto-selected.
3. **No automatic optimiser promotion.** Candidates are immutable until human approval.
4. **No agent self-approval.** Every P0/P1 implementation needs an independent reviewer.
5. **Contracts before consumers.** ADRs and schemas land before parallel implementation.
6. **Never fabricate an anchor.** Missing evidence → block, never guess.
