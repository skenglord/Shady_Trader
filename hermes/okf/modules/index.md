# Concepts

* [AI integration](ai-governance.md) - Local Ollama/Gemma-compatible model adapters for narrative validation, sentiment, signal generation and mode recommendation.
* [API server and WebSocket](api-server.md) - Express REST surface, privileged routes, and the WebSocket server with first-message token handshake.
* [Backtesting and replay](backtest-replay.md) - Backtest service and scripts; the intended basis for deterministic replay.
* [Balance Manager](balance-manager.md) - Main/bot balance split, allocation, active-trade accounting and trade-result recording.
* [CLI](cli.md) - Command-line monitor and control surface; REST-only, no WebSocket client.
* [Database Layer](database-layer.md) - SQLite and PostgreSQL persistence, worker-threaded queries, migrations with a schema_migrations state table, and backup.
* [Exchange Layer](exchange-layer.md) - Exchange adapters and connectors for Binance, Bybit, OKX, Kraken and Coinbase Advanced, plus reconciliation, pooling, backpressure and rotation.
* [Execution Lock](execution-lock.md) - Distributed trade lock intended to prevent concurrent or duplicate execution.
* [Freqtrade bridge](freqtrade-bridge.md) - Python Freqtrade sidecar integration: bridge, validation and backtest/data/validate workers.
* [Frontend SPA](frontend.md) - React + Vite dashboard. Decomposed by PR #14 from a 3,392-line App.tsx into a 293-line composition root plus feature modules.
* [Indicator Engine](indicators-engine.md) - Serial and worker-parallel technical indicator computation: EMA, RSI, Bollinger, ADX, MACD, ATR, VWAP, WaveTrend, MFI, VPI.
* [Infrastructure and deployment](infra-deploy.md) - Kubernetes manifests, Docker compose, Dockerfile, Postgres init and the GitHub Actions CI/CD pipeline.
* [Observability and logging](observability.md) - Structured logging with rotation, request metrics and Freqtrade metrics.
* [Optimisation and Monte Carlo](optimisation-montecarlo.md) - Bayesian optimiser, trial history, Monte Carlo engine, stress testing, correlation and risk calculators.
* [Paper trading](paper-trading.md) - Dedicated paper-trading service, order book, position tracker, state machine and WebSocket handler.
* [Regime Detector](regime-detector.md) - Legacy classifier plus three-axis composite regime classification with 7-day / 30-day / ATR-percentile windows.
* [Risk Manager](risk-manager.md) - Central risk configuration, position sizing, Kelly, circuit breakers, loss-streak tracking and drawdown.
* [Shadow Trader / execution path](shadow-trader.md) - Six parallel shadow portfolios plus the single live-execution path. Highest-risk module in the repo: owns entry, exit, PnL and the exchange calls.
* [Slippage, cost and liquidity](slippage-engine.md) - Cost estimator, fill calculator, impact simulator, liquidity analysis and the slippage circuit breaker.
* [Trading Engine (composition root)](trading-engine.md) - backend/main.ts — the operational monolith: DI, scheduling, cycle orchestration, config persistence, kill path, broadcasting.
