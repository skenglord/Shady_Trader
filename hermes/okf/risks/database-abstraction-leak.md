---
type: Risk
title: Postgres path is non-functional and configuration is unvalidated
description: Application-wide SQLite placeholder syntax is routed to the pg driver unchanged, and saved config JSON is merged with no schema validation.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/database.ts#L285-L286
tags:
  - p1
  - database
  - config
  - verified
  - root-cause
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-037, G-038 (and G-039, G-040 for config authority and write ordering).

# Affected code

* `backend/database.ts:285-286` — routes `?`-placeholder queries to `runPostgresQuery` when `USE_POSTGRES=true`.
* `backend/database_postgres.ts:593-599` — `migrateFromSQLite` emits `?` placeholders to `pg`.
* `backend/risk/manager.ts:237-239` — `JSON.parse(row.value)` spread into risk configs unvalidated.

# Why it matters

The `pg` driver requires `$1, $2` positional parameters, so **every** parameterised query fails at runtime
under Postgres — the dual-database capability is effectively broken, not merely inconsistent. At the same
moment, the risk configuration layer will accept arbitrary values such as negative leverage or a position
size above 1 without complaint.

# Verification status

**CONFIRMED** — materially more severe than the original register wording ("repeated parameter-count
mismatches").
