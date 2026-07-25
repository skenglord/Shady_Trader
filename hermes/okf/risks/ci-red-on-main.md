---
type: Risk
title: CI has been failing on main since before the remediation branch
description: The test and quality jobs fail on main at the pre-merge baseline and on every remediation commit; root cause is unknown because logs expired.
resource: https://github.com/skenglord/Shady_Trader/actions
tags:
  - p1
  - ci
  - tooling
  - verified
  - new-finding
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-076 (new — not present in the original G-001..G-075 register).

# Evidence

Check-run conclusions compared across commits:

* `main` @ `942dc974` (pre-merge) — `test` failure, `quality` failure.
* PR #14 @ `f040133`, `a161c8c`, `a11f1dd` — same two jobs failing.

Because the failures predate the remediation branch, they are baseline defects, not regressions
introduced by PR #14. Job logs had expired at the time of analysis, so the underlying cause is not yet
identified.

# Why it matters

QG-1 (build and static type safety) and QG-2 (unit and property tests) both assume a green pipeline as
their evidence source, so a persistently red CI removes the foundation those gates stand on. Every
downstream "tests pass" claim in the programme must otherwise be taken on trust.

# Verification status

**CONFIRMED** by check-run comparison. Root cause **UNKNOWN** — first task of the platform workstream is
to re-run CI and capture fresh logs.
