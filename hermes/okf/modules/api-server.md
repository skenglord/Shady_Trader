---
type: Module
title: API server and WebSocket
description: Express REST surface, privileged routes, and the WebSocket server with first-message token handshake.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/api/routes.ts
tags:
  - api
  - websocket
  - security-relevant
  - p2
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/api/routes.ts` (73.2 KB — the largest file in the repo) plus `backend/api/websocket.ts` and
root `server.ts`. PR #14 replaced query-string WebSocket tokens with a first-message auth handshake
(close code 4401 on invalid/timeout) and gated broadcasts behind an `authed` flag.

# Files that matter

* `backend/api/routes.ts` — REST surface; role-gated admin/trader routes.
* `backend/api/websocket.ts` — auth handshake, `WS_AUTH_TIMEOUT_MS`, authed-gated broadcast.
* `server.ts:195-197, 384` — Redis failure path; engine started with a null Redis client.

# Risks

* [Initialisation fails open](/risks/init-fails-open.md) — G-042
* [Operational security controls unproven](/risks/operational-security-unproven.md) — G-066, G-067
