# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Shady Trader** is an AI-augmented algorithmic trading platform supporting multiple risk modes running in parallel (Shadow Trading). It uses Gemini AI for regime detection, sentiment analysis, and signal confirmation.

## Common Commands

```bash
# Development
npm run dev          # Start dev server (tsx server.ts on port 3000)
npm run build        # Build frontend (vite build)
npm start            # Production server

# Testing
npm run test          # Run all tests (tsx --test tests/**/*.test.ts)
npm run test:coverage # Coverage report

# Quality Gates
npm run quality:ci           # Full CI: lint + test + coverage + complexity + audit
npm run quality:coverage      # Coverage check with threshold enforcement
npm run quality:complexity   # Cyclomatic complexity check
npm run security:audit       # Dependency vulnerability audit

# Playwright
npx playwright test          # UI/Integration tests
npx playwright test --headed  # Run with browser visible

# Deployment
npm run bot:launch            # Cross-platform launcher
docker-compose up -d          # Docker deployment
kubectl apply -f k8s/         # Kubernetes deployment
```

## Architecture

### Backend (`backend/`)

```
main.ts                    # TradingEngine class - core cycle orchestration
  └── runCycle(): fetch candles → indicators → regime → signal → execute

api/
  ├── routes.ts            # Express REST API endpoints
  ├── marketDataService.ts # Market data fetching with circuit breaker fallback
  └── websocket.ts         # Real-time data broadcasting

exchange/
  ├── connector.ts         # Multi-exchange support (CMC/Binance/Kraken/OKX/Coinbase)
  └── adapter.ts           # Typed adapter factory pattern

indicators/engine.ts       # Technical indicators (RSI, MACD, Bollinger Bands, EMA)

regime/detector.ts         # AI-enhanced regime detection with news sentiment

strategy/
  ├── signal_generator.ts  # Signal generation based on regime + indicators
  └── optimization_engine.ts # Bayesian hyperparameter optimization

shadow/shadow_trader.ts    # Shadow trading across 6 risk modes
risk/manager.ts             # Risk management with circuit breakers
slippage/                   # Transaction cost modeling (Almgren-Chriss, liquidity analysis)
paper-trading/             # Paper trading with order lifecycle state machine
monte-carlo/              # Portfolio simulations and stress testing
```

### Frontend (`src/`)

React dashboard with Zustand state management, TradingView-style charts via lightweight-charts.

### Infrastructure

- **Database**: SQLite (dev) / PostgreSQL (prod) via better-sqlite3/pg
- **Caching**: Redis (optional, degrades gracefully when unavailable)
- **Job Queues**: BullMQ for distributed scheduling
- **Observability**: Prometheus metrics, OpenTelemetry tracing, structured JSON logging

## Trading Strategies

| Strategy | Description |
|----------|-------------|
| **Regime** (default) | Technical indicators + AI confirmation based on detected market regime |
| **Shotgun** | Enter/exit near candle boundaries |
| **Alt Chaser** | Trade on BTC >1% moves |
| **Chasing Dragons** | Add leverage if probability improves within candle |

## Risk Modes

Six modes run in parallel (shadow portfolios):
- `ultra_conservative` → `conservative` → `moderate` → `aggressive` → `degen`
- Each has position size, leverage, active regimes, and circuit breaker thresholds

## Market Data Providers

Configured via `PRIMARY_EXCHANGE` / settings UI:
- **CoinMarketCap** (primary) - requires API key
- **CoinGecko** (free fallback)
- **CryptoCompare**, **Binance**, **Kraken**, **OKX**, **Coinbase**

## LLM Usage Guidelines

**Permitted**: Sentiment scoring, narrative generation, contextual probability multiplier (meta-labeling with constrained multiplier -0.4 to 0.4).

**Prohibited**:
- Direct OHLCV/indicator analysis by LLM
- Synchronous trade execution gates (must be async)
- Capital preservation decisions or system halts
- Hyperparameter optimization (use Bayesian optimization instead)

All LLM outputs must pass Zod validation with graceful fallback to neutral values.

## API Authentication

- `API_ADMIN_TOKEN` - admin routes (bot lifecycle, settings, backtest, optimize)
- `API_TRADER_TOKEN` - trader routes (trades, positions, allocation)
- Header: `Authorization: Bearer <TOKEN>` or `x-api-token: <TOKEN>`
- Production: privileged routes fail 503 when no token configured

## Environment Variables

Key variables (see `backend/config/validation.ts` for full Zod schema):
- `PRIMARY_EXCHANGE`, `EXCHANGE_API_KEY`, `EXCHANGE_API_SECRET`
- `MARKET_DATA_API_KEY`, `REDIS_HOST`, `REDIS_PASSWORD`
- `GEMINI_API_KEY`, `SESSION_SECRET`
- `PORT`, `NODE_ENV`, `LOG_LEVEL`

## Key Patterns

- **Circuit breakers**: 5+ consecutive losses → 50% position reduction; 7+ → 25%
- **Graceful degradation**: Redis optional, exchange failures fallback to cached/simulated
- **Structured logging**: JSON with correlation IDs (`x-request-id`)
- **Abortable cycles**: Trading engine uses timeout-based abort to prevent infinite loops