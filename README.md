# AI Shadow Trading System Documentation

## Overview
This system is an AI-augmented algorithmic trading platform that supports multiple risk modes running in parallel (Shadow Trading). It uses a local Ollama Gemma adapter for non-blocking signal confirmation, with rule-based fallback when the AI path is disabled or unavailable.

## API Integrations

The system integrates with two types of external APIs: **Exchange APIs** (for live trading and fallback market data) and **Market Data APIs** (for primary chart data and sentiment).

### Exchange APIs
These APIs are used to execute live trades when a shadow trade is triggered in the active mode. They can also be used as a fallback for fetching OHLCV (candlestick) data.

1. **Binance**
   - **Required Fields**: `API Key`, `API Secret`
   - **Notes**: Supports Testnet. Ensure your API key has Spot Trading enabled.

2. **Bybit**
   - **Required Fields**: `API Key`, `API Secret`
   - **Notes**: Supports Testnet. Ensure your API key has Spot Trading enabled.

3. **OKX**
   - **Required Fields**: `API Key`, `API Secret`, `API Password` (Passphrase)
   - **Notes**: OKX requires a third credential (the passphrase you set when creating the API key). Supports Testnet.

4. **Kraken**
   - **Required Fields**: `API Key`, `API Secret`
   - **Notes**: Does not have a standard Testnet for spot trading via ccxt in the same way as Binance/Bybit.

5. **Coinbase (Advanced Trade)**
   - **Required Fields**: `API Key`, `API Secret`, `API Password` (Passphrase - required for some older Pro keys, but new Advanced Trade keys might just need Key/Secret. If using Legacy Pro, provide the passphrase).
   - **Notes**: Ensure you are using the new Advanced Trade API keys.

### Market Data APIs
These APIs are used to fetch historical and live candlestick data for the charts and indicators.

1. **CoinGecko**
   - **Required Fields**: `API Key` (Optional)
   - **Notes**: The public API does not require a key but is heavily rate-limited. If provided, the backend appends your key to requests. No hardcoded demo key fallback is used.

2. **CoinMarketCap**
   - **Required Fields**: `API Key`
   - **Notes**: Requires a paid plan for historical OHLCV data. The basic tier does not support it.

3. **CryptoCompare**
   - **Required Fields**: `API Key`
   - **Notes**: Provides excellent historical OHLCV data. The free tier is usually sufficient for standard timeframes.

4. **Glassnode**
   - **Required Fields**: `API Key`
   - **Notes**: Primarily used for on-chain metrics rather than standard OHLCV.

5. **Messari**
   - **Required Fields**: `API Key`
   - **Notes**: Uses the `x-messari-api-key` header. Good for fundamental data and sentiment.

## Trading Strategies

### 1. Regime Based (Default)
Uses technical indicators (EMA, RSI, Bollinger Bands) and AI confirmation to trade based on the detected market regime (Strong Bull, Weak Bull, Bear, Sideways).
Now includes **news-sentiment weighting** from market context (`sentiment_score` / `news_sentiment`) to adjust regime confidence and bias uncertain regimes when sentiment is strongly directional.

### 2. Shotgun
Initiates a buy or sell order 0.5 seconds before the end of every candle and closes the order 10 seconds after.
- **Configurable**: Time before candle end, time after candle end.

### 3. Alt Chaser
Initiates buy or sell orders whenever Bitcoin's price increases or decreases by more than 1% over the time period of one single candle.
- **Configurable**: Percentage change threshold.

### 4. Chasing Dragons
After initiating a trade, if the probability score leaving the candle is the same or better than it was at the beginning of the candle, leverage is added to the order.
- **Default**: 7x leverage, 6% stop loss.
- **Configurable**: Leverage amount, stop loss percentage.

## Configuration
To configure these APIs and strategies:
1. Open the Settings modal (gear icon) in the UI.
2. Select your Primary Exchange and Market Data API.
3. Select your Trading Strategy and configure its parameters.
4. Enter the required keys.
5. Alternatively, you can set `EXCHANGE_API_KEY` and `EXCHANGE_API_SECRET` in your `.env` file for the default exchange.

### API Security (Backend)
- Privileged `/api` endpoints now support **role-based token protection**:
  - `API_ADMIN_TOKEN` for admin routes (bot lifecycle, settings/risk-config mutation, backtest, optimize, kill, CSV import, ML status/accuracy/predictions, Freqtrade download/backtest/validate/ingest)
  - `API_TRADER_TOKEN` for trader routes (timeframe, market refresh/data, manual trade, position controls, allocation/withdrawal, active mode, manual regime, signals, trades, slippage, diagnostics, Freqtrade info/pairs/jobs)
- Public probes: `/api/health/live`, `/api/health/ready`, `/api/health/quick`, and `/api/status`.
- Backward compatibility: `API_AUTH_TOKEN` is still accepted as an admin token fallback.
- Send either:
  - `Authorization: Bearer <TOKEN>` or
  - `x-api-token: <TOKEN>`
- In `production`, privileged routes fail closed (`503`) when no auth token is configured.
- Mutating endpoints now enforce request validation (type/shape/range checks) before execution.
- Validation schemas are implemented with **Zod** for consistent runtime type enforcement.

### Frontend Security & Auth (operator-supplied tokens)
- **No secrets in the bundle.** Auth tokens (`API_ADMIN_TOKEN`, `API_TRADER_TOKEN`) and `GEMINI_API_KEY` are **never** compiled into the SPA — they were removed from `vite.config.ts`'s `define`. An operator enters tokens at app start via a token-entry UI; they are held in **module-scoped memory only** (`src/auth/tokenStore.ts`) and never written to localStorage, sessionStorage, cookies, or the URL. They are lost on page reload by design.
- The frontend attaches `x-api-token: <token>` to API calls (admin token for admin-prefixed routes, trader token otherwise), sourced from the in-memory store at call time.
- **WebSocket auth is a first-message handshake**, not a query-string token. The client connects with a clean URL and sends `{"type":"auth","token":"<trader_token>"}` as its first message; the server replies `{"type":"auth_ok","role":"trader"}` and closes with code `4401` on invalid token, timeout (`WS_AUTH_TIMEOUT_MS`, default 5s), or when no tokens are configured server-side. This keeps tokens out of access logs, browser history, and Referer headers. Broadcasts are gated behind an `authed` flag — no data flows to an unauthenticated socket.
- Server-side `GEMINI_API_KEY` is still read from `process.env` by the `/api/risk-configs/ai-recommend` endpoint (unchanged); only the frontend/bundle injection was removed.

### Frontend Architecture
- `src/App.tsx` is a **composition root** (~290 lines) that imports and composes feature modules with explicit props (data down, callbacks up):
  - `src/api/client.ts` — shared `safeFetch` (two-layer LRU cache, 5s TTL, 100-entry cap, in-flight dedup) integrated with the token store.
  - `src/hooks/useTradingWebSocket.ts` — WS lifecycle (connect, auth handshake, reconnect with max-5 attempts).
  - `src/components/` — `ChartPanel`, `TradeTables`, `BalanceControls`, `BacktestOverlay`, `RiskConfigModal`, `EngineControls`, `FreqtradePanel`, `MLDashboard`.
- **MLDashboard** is reachable via a "ML Dashboard" toolbar button that opens a monitoring modal (`/api/ml/*` endpoints). It degrades gracefully when `ML_ENABLED=false`.

### Database Migrations
- Migrations are tracked in a `schema_migrations` state table (`backend/migrations/runner.ts`): each of the 5 migrations runs exactly once and is skipped on subsequent boots. `listAppliedMigrations()` returns applied ids. Schema DDL is owned by application startup (`backend/database_postgres.ts` + `backend/migrations/`); `docker/postgres/init.sql` and the `k8s/configmap.yaml` init block are bootstrap+seed-only (idempotent default balance row).

### Diagnostics
- `GET /api/diagnostics/startup`: public startup configuration status (non-secret), exchange readiness, mode/timeframe context.
- `GET /api/diagnostics/health`: public runtime heartbeat including uptime, request-level API telemetry, market-data cache status, Redis status, and ML health.
- `GET /api/diagnostics/metrics`: public Prometheus-style plaintext metrics for API, market-data, and Freqtrade counters/latencies.
- Startup diagnostics now also include `exchangeCapabilities` (provider support flags for live trading/account/public data).

### Structured Logging & Correlation IDs
- Backend logging now emits structured JSON records (`ts`, `level`, `message`, contextual fields).
- API middleware accepts inbound `x-request-id` and echoes it in responses for request correlation.
- Set `LOG_LEVEL` (`debug|info|warn|error`) to control log verbosity.

### Exchange & Secrets Configuration
- Configure exchange provider through settings and/or environment:
  - `EXCHANGE_NAME` (default: `coingecko`)
  - `EXCHANGE_API_KEY`
  - `EXCHANGE_API_SECRET`
  - `EXCHANGE_API_PASSWORD`
  - `EXCHANGE_USE_TESTNET` (`true`/`false`)
- Public market-data polling can run without authenticated credentials for CoinGecko/Binance/Kraken-style public data.
- Authenticated trade/account actions require provider-specific API credentials for Binance/Kraken/OKX/Coinbase adapters.


## Cross-Platform Quick Launcher
Use the shortcut launcher to install dependencies and boot the bot with one command across Windows/macOS/Linux variants (Ubuntu/Arch/Fedora), plus Android/iOS shell environments:

- Default auto-detect + dev mode:
  - `npm run bot:launch`
- Force specific target (examples):
  - `npm run bot:launch -- --target windows`
  - `npm run bot:launch -- --target macos`
  - `npm run bot:launch -- --target ubuntu`
  - `npm run bot:launch -- --target arch`
  - `npm run bot:launch -- --target fedora`
  - `npm run bot:launch -- --target android`
  - `npm run bot:launch -- --target ios`
- Production boot:
  - `npm run bot:launch -- --mode start`
- Skip dependency install:
  - `npm run bot:launch -- --skip-install`

Notes:
- Android/iOS usage assumes a terminal runtime with Node.js (e.g., Termux on Android, iSH/a-Shell on iOS).
- Mobile targets automatically bind dev host as `0.0.0.0` for LAN access.

## Testing
Run `npm test` to execute the full backend test suite (`tests/**/*.test.ts`). Current audit status: full suite passes in serial spec mode; targeted lifecycle suite also passes 33/33.

## Quality Gates
- `npm run quality:coverage` — executes coverage and enforces baseline thresholds.
- `npm run quality:complexity` — enforces cyclomatic complexity ceiling.
- `npm run security:audit` — runs dependency vulnerability audit (`npm audit --omit=dev --audit-level=high`).
- `npm run quality:ci` — runs lint + tests + coverage + complexity + audit (end-to-end local CI parity).
- `npm run lint` currently passes.
- `npm run build` currently passes.
- `npm run quality:ci` is not green until coverage, complexity, and audit gates are verified.
- Current observed coverage in this environment: not verified during this audit.

## API Gateway & Load Balancing (Phase 1.4)

For multi-instance Kubernetes deployments, the system includes:

- **NGINX Ingress Controller** with TLS termination, rate limiting, and security headers
- **Horizontal Pod Autoscaler (HPA)** scaling 2-10 replicas based on CPU/memory
- **WebSocket sticky session support** for real-time trading updates
- **Load balancing** with health checks and graceful shutdown

Kubernetes manifests in `k8s/`:
- `ingress.yaml` - NGINX ingress with TLS, rate limiting, security headers
- `hpa.yaml` - HorizontalPodAutoscaler configuration
- `nginx-config.yaml` - NGINX configuration for rate limiting

Apply with: `kubectl apply -f k8s/`

For a current architectural/health appraisal and prioritized recommendations, see:
- `documentation/current_state_and_recommendations.md`
