---
type: Module
title: Database Layer
description: SQLite and PostgreSQL persistence, worker-threaded queries, migrations with a schema_migrations state table, and backup.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/database.ts
tags:
  - persistence
  - database
  - p1
  - migration
timestamp: 2026-07-26T00:00:00Z
---

# Overview

Dual-target persistence: `database.ts` (SQLite), `database_postgres.ts`, `database_worker.ts`, plus
`backend/migrations/` (five migrations and a runner). PR #14 added a `schema_migrations` state table and
made application startup the single owner of DDL. The Postgres path, however, is not functional.

# Files that matter

* `backend/database.ts:101` — `main_balance REAL NOT NULL DEFAULT 100000`.
* `backend/database.ts:226-240` — `signals` table schema; no UNIQUE on (symbol, candle_time).
* `backend/database.ts:285-286` — routes `?`-placeholder queries to Postgres when `USE_POSTGRES=true`.
* `backend/database_postgres.ts:130, 537` — schema and idempotent seed of the default balance row.
* `backend/database_postgres.ts:593-599` — `migrateFromSQLite` emits `?` placeholders to the `pg` driver.
* `backend/migrations/runner.ts` — migration state tracking (added by PR #14).

# Risks

* [Database abstraction leak](/risks/database-abstraction-leak.md) — G-037, G-038, G-039, G-040
* [No exact-once candle processing](/risks/exact-once-execution.md) — G-025
