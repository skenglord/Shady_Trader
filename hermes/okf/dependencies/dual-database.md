---
type: Dependency
title: SQLite and PostgreSQL
description: Dual persistence targets selected by USE_POSTGRES, with Redis for runtime state. The Postgres path is currently non-functional.
resource: https://www.postgresql.org/docs/
tags:
  - database
  - persistence
  - p1
timestamp: 2026-07-26T00:00:00Z
---

# Concern

The application speaks SQLite `?` placeholders everywhere, but the `pg` driver requires `$1, $2`
positional parameters and no translation layer exists — see
[database-abstraction-leak](/risks/database-abstraction-leak.md). Authority is also split between Redis
and the relational store (G-039). Treat Postgres as unsupported until the placeholder layer is fixed.
