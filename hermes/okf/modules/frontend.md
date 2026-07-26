---
type: Module
title: Frontend SPA
description: React + Vite dashboard. Decomposed by PR #14 from a 3,392-line App.tsx into a 293-line composition root plus feature modules.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/src
tags:
  - frontend
  - react
  - resolved-by-pr14
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`src/` is the React frontend (not backend domain code). **Materially changed by PR #14**: `App.tsx` went
from a 3,392-line monolith to a ~293-line composition root composing eight feature modules, with an
in-memory token store replacing bundled secrets.

# Files that matter

* `src/App.tsx` — composition root.
* `src/auth/tokenStore.ts` — in-memory operator token store; never localStorage/cookies/URL.
* `src/api/client.ts` — shared `safeFetch` with LRU cache and in-flight dedup.
* `src/hooks/useTradingWebSocket.ts` — WS lifecycle and auth handshake.
* `src/components/` — eight feature components including `MLDashboard.tsx`.

# Notes for agents

This tree is owned by frontend profiles only. Backend profiles must never write here. The historical
risks `monolithic-app-tsx`, `tokens-in-frontend-bundle`, `token-in-ws-url` and `mldashboard-unreachable`
were closed by PR #14 — see [closed by PR 14](/risks/closed-by-pr14.md).
