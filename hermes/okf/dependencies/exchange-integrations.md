---
type: Dependency
title: Exchange integrations
description: CCXT-style adapters for Binance, Bybit, OKX, Kraken and Coinbase Advanced. Each has distinct order semantics, margin models and reduce-only support.
resource: https://github.com/ccxt/ccxt
tags:
  - exchange
  - integration
  - money-path
timestamp: 2026-07-26T00:00:00Z
---

# Concern

Five venues are supported but contract semantics differ per exchange — position sides, reduce-only flags,
margin tiers and liquidation models are not uniform. Any order-lifecycle or PnL work must be validated
per venue rather than assumed portable, and derivatives liquidation modelling is currently simplified
(G-075).
