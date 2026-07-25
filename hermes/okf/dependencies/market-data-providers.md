---
type: Dependency
title: Market-data providers
description: CoinGecko, CoinMarketCap, CryptoCompare, Glassnode and Messari, accessed through a provider rotator.
resource: https://www.coingecko.com/en/api
tags:
  - market-data
  - integration
  - rate-limits
timestamp: 2026-07-26T00:00:00Z
---

# Concern

Multiple providers with differing rate limits, history depth and timestamp conventions sit behind
`backend/exchange/provider-rotator.ts`. Point-in-time correctness and provenance must be established per
provider before any of them can support a deterministic replay.
