#!/usr/bin/env bash
# Bootstrap the ASTS hardening programme on a Hermes Kanban board.
#
# Supersedes bootstrap_hermes_crypto_hardening.sh, which pointed at the
# monolithic enterprise_crypto_trading_bot_agentic_hardening_v3_complete.md.
# That document is now decomposed into hermes/00-INDEX.md .. hermes/10-OKF-GUIDE.md
# plus the OKF knowledge bundle at hermes/okf/.
#
# Baseline: 63f1ecc0a2a90b8035cd8773e897e0953577c523 (skenglord/Shady_Trader, post PR #14)
set -euo pipefail

BOARD="crypto-trading-hardening"
BASELINE="63f1ecc0a2a90b8035cd8773e897e0953577c523"

hermes kanban boards create "$BOARD" \
  --name "Crypto Trading Bot Hardening" \
  --description "Enterprise execution, accounting, risk, data, replay, AI governance, and release programme" \
  --icon "🛡️" \
  --switch || true

hermes gateway start

hermes kanban --board "$BOARD" create \
  "ASTS enterprise hardening and governed optimisation programme" \
  --assignee orchestrator \
  --tenant ASTS \
  --triage \
  --goal \
  --priority 0 \
  --idempotency-key "asts-hardening-programme-v4-63f1ecc0" \
  --max-runtime 2h \
  --json \
  --body "$(cat <<'BODY'
Baseline: 63f1ecc0a2a90b8035cd8773e897e0953577c523 (skenglord/Shady_Trader main, post PR #14 merge).

SPECIFICATION — read in this order, do not load the whole set at once:
  hermes/00-INDEX.md               root index, orchestration boundary, constraints
  hermes/01-SYSTEM-OVERVIEW.md     current + target architecture, REAL repo layout
  hermes/02-GAP-REGISTER.md        76 gaps with verification status and anchors
  hermes/03-COMPONENT-FINDINGS.md  per-component findings
  hermes/04-IMPLEMENTATION-PLAN.md 11 phases with exit criteria
  hermes/05-QUALITY-GATES.md       QG-0..QG-11 and release gates
  hermes/06-HERMES-OPERATING-MODEL.md  profiles, CORRECTED write scopes, task schema
  hermes/07-TRADING-MATHEMATICS.md corrected PnL, sizing, Kelly, drawdown
  hermes/08-QUANT-PROTOCOL.md      research integrity and promotion workflow
  hermes/09-EPICS-AND-RUNBOOK.md   epics E0-E9 and the 12-step runbook
  hermes/10-OKF-GUIDE.md           how to read/update the knowledge bundle
  hermes/okf/index.md              OKF bundle: 20 Modules, 28 Risks, 5 Dependencies

CRITICAL GROUND TRUTH:
  * backend/** is ALL backend domain code. src/** is the React FRONTEND ONLY.
    The src/domain/** tree in older specs DOES NOT EXIST. Never assign backend work there.
  * Every task must cite its OKF concept path(s) and gap ID(s).
  * Gaps marked UNVERIFIED must be VERIFIED before they are fixed. If the defect
    does not exist, block with `gap-not-reproducible:` — never invent a fix.
  * Root-cause clusters (02-GAP-REGISTER.md) must NOT be parallelised. C1
    (exchange-as-side-effect, 6 gaps) is ONE sequenced workstream in one file.
  * backend/main.ts is touched by 5 phases — treat every edit as an exclusive lock.

CONSTRAINTS (non-negotiable):
  * No live trading. liveArmed=false is a startup invariant.
  * No AI authority over risk. No automatic optimiser promotion.
  * Every P0/P1 implementation requires independent review and verification.
  * QG-11 (human live-capital approval) is NEVER agent-approvable.
  * Preserve and close every finding G-001 through G-076.

Decompose contracts-first. Run E0 (safety freeze) before anything else.
BODY
)"

hermes kanban --board "$BOARD" stats
echo
echo "Board seeded at baseline ${BASELINE}."
echo "Open the Hermes dashboard and review triage children before promotion."
echo "Keep auto_promote_children=false for P0/P1 work."
