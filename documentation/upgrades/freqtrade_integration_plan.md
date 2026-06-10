# Freqtrade Integration — Technical Analysis & Implementation Roadmap

> **Project:** Shady_Trader (Adaptive Trading System)
> **Scope:** Backtesting engine + historical market data acquisition
> **Status:** Core Freqtrade implementation is present. Build, lint, and tests now pass; coverage/complexity/audit gates are not verified.
> **Author analysis date:** 4 June 2026

---

## 1. Executive Summary

The repository already contains an in-house backtester (`backend/scripts/backtest.ts` → `computeBacktestMetrics`) and a multi-source candle pipeline (primary exchange → CryptoCompare → CoinGecko fallback, see `backend/api/routes.ts:692-777`). A **Freqtrade sidecar scaffold** exists at `backend/freqtrade/` with venv installer, start/stop scripts, smoke test, and a `user_data/config.json` for `binance` futures dry-run — but it is **not yet invoked from the TypeScript engine, the Express API, or the CLI**.

This plan answers three questions:
1. **What does Freqtrade's backtester and data-downloader actually do** (analysis based on stable documentation as of 2025/2026)?
2. **Where are the integration bottlenecks** with the current Node/TS architecture?
3. **What is the optimal step-by-step rollout** that addresses data management, backtesting accuracy, and deployment workflows?

The conclusion: Freqtrade is a **complementary sidecar**, not a replacement. The plan introduces a thin Python child-process bridge that delegates two narrow jobs (bulk historical download + reference-grade backtest) to Freqtrade's battle-tested CLI, while the live/paper trading loop remains in the TypeScript engine. This gives us industry-standard historical data acquisition, multi-exchange coverage, and an independent validation harness for our indicator→regime→signal pipeline — without rewriting the live trading path.

---

## 2. Current State Audit

### 2.1 What already exists in Shady_Trader

| Concern | Existing component | Location | Status |
|---|---|---|---|
| In-house backtest metrics | `computeBacktestMetrics()` | `backend/scripts/backtest.ts:29-74` | Computes Sharpe, MDD, PF, win-rate, total PnL from `trades[]` |
| In-house backtest entrypoint | `engine.runBacktest()` | `backend/main.ts:1101-1180` | Fetches candles, runs indicator→regime→signal, returns trades |
| Backtest API | `POST /api/backtest` | `backend/api/routes.ts:1118` | Validates Zod schema, calls `engine.runBacktest()` |
| CLI wrapper | `npm run backtest` | `package.json:24` | Spawns `tsx backend/scripts/backtest.ts` |
| Primary candles | `ExchangeConnector.getCandles()` | `backend/exchange/connector.ts:693` | Per-cycle, max 200 candles |
| Historical candles (1y) | `ExchangeConnector.getHistoricalCandles()` | `backend/api/routes.ts:708` | Used by `/api/candles?history=1y` |
| Fallback #1 | CryptoCompare | `backend/api/routes.ts:725-733` | `engine.exchange?.fetchCryptoCompareHistorical?.(...)` |
| Fallback #2 | CoinGecko (free tier) | `backend/api/routes.ts:22-69` | OHLC, daily only, no volume |
| Market data circuit breaker | `MarketDataService` | `backend/api/marketDataService.ts:53-87` | 3-failure threshold, 5-min cooldown |
| Freqtrade venv | `requirements.txt` (2026.5.1 pinned) | `backend/freqtrade/requirements.txt` | Not yet installed |
| Freqtrade sidecar scripts | `install_freqtrade.sh`, `start_server.sh`, `stop_server.sh`, `smoke_test.py` | `backend/freqtrade/scripts/`, root | Operational, `/api/v1/ping` smoke only |
| Freqtrade user config | `user_data/config.json` (binance futures dry-run) | `backend/freqtrade/user_data/config.json` | Has `${FREQTRADE_JWT_SECRET_KEY}` env binding |
| npm scripts | `freqtrade:install` / `freqtrade:up` / `freqtrade:down` / `freqtrade:smoke` | `package.json:38-41` | Wired |

### 2.2 What is missing

1. **No Freqtrade strategy file** in `user_data/strategies/`. The sidecar has a config but no `IStrategy` class to backtest.
2. **No historical-data downloader wiring** — `freqtrade download-data` is not invoked anywhere.
3. **No backtest invocation bridge** — `freqtrade backtesting` is not run from `npm`, CLI, or API.
4. **No trade-result reconciliation** between Freqtrade's `backtest_results/*.json` and the in-house `shadow_trades` table.
5. **No auth integration** — Freqtrade's webserver JWT (`${FREQTRADE_JWT_SECRET_KEY}`) is independent of the main API's `API_TRADER_TOKEN`.
6. **No idempotency / job-queue integration** — bulk historical downloads can take 10–30 minutes and would block the main API if invoked inline.
7. **No data-conformance tests** — no assertion that the candles the sidecar downloaded match the format the in-house indicators expect.
8. **No docs in `documentation/`** describing the integration pattern, lifecycle, or rollback.

### 2.3 Gaps the in-house backtester has (where Freqtrade helps)

| Limitation | Freqtrade strength |
|---|---|
| Single-exchange data via `ExchangeConnector` | `freqtrade download-data --exchange binance kraken okx coinbase ...` covers 17+ exchanges |
| Manual timeframe aggregation in `aggregateFromBaseTimeframe()` | Proper OHLCV resampling in Freqtrade with fund-rate + mark-price support |
| No futures-specific fields (funding rate, mark price, OI) | Native futures data via `--trading-mode futures` |
| No bulk download (max ~1000 candles per call) | Streaming, paginated, rate-limit-aware downloader |
| No multi-strategy backtest comparison | `freqtrade backtesting --strategy-list` runs N strategies in one pass |
| Manual Sharpe/MDD calculation | Stdlib metrics + optional `--export trades` (parquet/CSV/JSON) |
| No parameter robustness sweep | Hyperopt module (Bayesian + epoch-based) — `freqtrade hyperopt` |

---

## 3. Freqtrade Documentation Analysis (Key Concepts)

The analysis below is distilled from Freqtrade's stable documentation (current as of the `2026.5.1` pin in `requirements.txt`). Web access for live re-verification was unavailable at the time of writing; for exact CLI flag syntax, always cross-check against `freqtrade <subcommand> --help` after install.

### 3.1 Backtesting engine — `freqtrade backtesting`

**Purpose**: Replays a strategy over historical OHLCV data, simulates realistic entry/exit, and reports performance metrics.

**Core CLI**:
```
freqtrade backtesting \
  --config user_data/config.json \
  --strategy MyStrategy \
  --timeframe 1h \
  --timerange 20240101-20251231 \
  --export trades      # writes backtest_results/backtest-result-*.json
  --export-filename ./backtest_results/run.json
  --breakdown day month year
  --cache none         # disable indicator cache
```

**Key inputs**:
- `--strategy` — name of an `IStrategy` subclass in `user_data/strategies/`.
- `--strategy-list` — comma-separated names for multi-strategy comparison.
- `--timerange` — `YYYYMMDD-YYYYMMDD`, `YYYYMMDD-`, or `-YYYYMMDD`. **Note: dates, not datetimes.**
- `--timeframe` — `1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w`.
- `--pairs` or `--pair-list-file` — restrict the universe.
- `--enable-protections` — apply the protections framework (e.g. `StoplossGuard`, `MaxDrawdown`).
- `--dry-run-wallet` — initial capital for the simulation.
- `--fee` — override exchange fee (otherwise pulled from `config.json`).
- `--data-format-ohlcv` — `json` (default), `feather`, or `parquet`. Parquet is 5–10× faster to load.

**Outputs**:
- Stdout table: per-pair and aggregate metrics (abs profit, profit %, Sharpe, MDD, win-rate, profit factor, expectancy, trades/day).
- `--export trades`: per-trade ledger (entry/exit timestamps, fees, slippage simulated from `ask/bid` if configured).
- `--export signals`: the signal log per candle.
- `backtest_results/.last_result.json` — pointer to the latest run (used by the webserver).

**Config-side requirements** (`config.json`):
- `dry_run: true` is required for backtest (no real orders).
- `unfilledtimeout` controls how long simulated limit orders wait for fill.
- `order_types` determines whether entries/exits are limit/market (affects fill probability).
- `fee` if you want to override the per-pair fee inferred from the exchange.
- `trading_mode: spot | futures | margin` — affects funding cost, leverage, and liquidation logic in futures mode.

**Strategy contract (`IStrategy`)**:
```
class MyStrategy(IStrategy):
    INTERFACE_VERSION = 3           # 3 = current stable
    timeframe = '1h'
    can_short = False
    minimal_roi = {'0': 0.10}
    stoploss = -0.10
    trailing_stop = False
    startup_candle_count: int = 30

    def populate_indicators(self, dataframe, metadata): ...
    def populate_entry_trend(self, dataframe, metadata): ...
    def populate_exit_trend(self, dataframe, metadata): ...
```

**Bottlenecks & gotchas** (from docs + community experience):
1. **`startup_candle_count` undercount** — if you reference `dataframe['ema200']` but set `startup_candle_count=30`, the first 170 candles will silently be `NaN`. The strategy must specify the largest lookback it needs.
2. **`INTERFACE_VERSION` mismatch** — v2 vs v3 strategies differ in how `populate_exit_trend` interacts with `minimal_roi` and `stoploss`. v3 is mandatory for current stable.
3. **Spot vs futures semantics** — `can_short=True` + `futures` mode enables short selling with leverage and funding-rate accounting.
4. **`--timerange` is inclusive of the start date, exclusive of the end date** — common source of off-by-one backtest ranges.
5. **Indicator caching** — Freqtrade caches computed indicators on disk keyed by strategy+timeframe+pairs. If you change a strategy without `--cache none`, you'll get stale results. For our CI, always set `--cache none`.
6. **No multi-timeframe frames by default** — multi-TF strategies must call `informative()` to merge higher TFs; the auxiliary TF must be downloaded separately.
7. **Funding rate in futures** — only present in data when downloaded with `--trading-mode futures`; backtest will skip funding accounting otherwise.
8. **Memory** — a 4-year 1m backtest on 50 pairs can use 4–6 GB RAM. For 1m/5m heavy backtests, scale the worker or split by pair batch.

### 3.2 Data download — `freqtrade download-data`

**Purpose**: Pull historical OHLCV from one or more exchanges to a local Parquet/Feather/JSON store, optionally with funding rates and mark prices.

**Core CLI**:
```
freqtrade download-data \
  --exchange binance \
  --pairs BTC/USDT ETH/USDT \
  --timeframes 1m 5m 1h 1d \
  --timerange 20200101- \
  --trading-mode futures \
  --data-format-ohlcv parquet \
  --erase                      # clean before download
  --include-inactive-pairs
```

**Key inputs**:
- `--exchange` — repeat for multiple exchanges.
- `--pairs` — restrict to a list; otherwise all `pair_whitelist` is used.
- `--timeframes` — space-separated.
- `--timerange` — same syntax as backtest.
- `--trading-mode spot | futures | margin` — controls which endpoint (spot vs USDT-M vs COIN-M) is hit.
- `--data-format-ohlcv json | feather | parquet` — Parquet recommended for size + speed.
- `--days` — alternative to `--timerange`; pulls the last N days.
- `--prepend` — add historical data before what's already on disk.
- `--dl-trades` — also download historical trades (used by FreqUI's "trades view" + slippage models).
- `--exchange-config <path>` — per-exchange credentials file (when downloading with auth).

**Output layout** (`user_data/data/<exchange>/`):
```
<exchange>/
  BTC_USDT-1h.feather     # OHLCV
  BTC_USDT-1h-mark.feather  # mark price (futures)
  BTC_USDT-1h-futures.feather  # funding rates
  BTC_USDT-trades.feather  # if --dl-trades
```

**Bottlenecks & gotchas**:
1. **Rate limits** — Freqtrade respects per-exchange rate limits but can still hit Binance/OKX 429s on 1m bulk pulls. Add `--sleep-limit` to extend the cool-off (community workaround) or run in `--dry-run` first to gauge volume.
2. **Incomplete public history** — many exchanges only expose 1m for the last ~6–12 months. For multi-year 1m, you need the trade-aggregation path.
3. **Spot vs futures pair naming** — `BTC/USDT` (spot) vs `BTC/USDT:USDT` (USDT-M futures). A spot config and a futures config cannot share the same `pair_whitelist`.
4. **Pair-list changes** — if a token gets delisted, Freqtrade emits a warning but skips. Use `--include-inactive-pairs` to retain history for delisted tokens (useful for forensics).
5. **Storage** — 4y × 50 pairs × 1m OHLCV in Parquet ≈ 8–12 GB on disk. Plan for a `data/` volume mount in k8s.
6. **`--exchange-config` permissions** — the file must be readable by the Freqtrade user; never bake secrets into the repo.

### 3.3 REST API — `freqtrade webserver` (the sidecar we already scaffolded)

The sidecar is already started by `start_server.sh` on port 8081 (configurable via `FREQTRADE_LISTEN_PORT`). The relevant endpoints for our integration:

| Endpoint | Method | Auth | Use |
|---|---|---|---|
| `/api/v1/ping` | GET | none | liveness (already in `smoke_test.py`) |
| `/api/v1/info` | GET | JWT | version + strategy list |
| `/api/v1/backtest` | POST | JWT | start a backtest job |
| `/api/v1/backtest/{id}` | GET | JWT | poll status / get result |
| `/api/v1/trades` | GET | JWT | list trades (live or backtest, depending on bot mode) |
| `/api/v1/available_pairs` | GET | JWT | list downloaded pairs/timeframes |
| `/api/v1/download_data` | POST | JWT | kick off a `download-data` job (async) |

**Auth** — JWT signed with `jwt_secret_key` from `config.json`. The token expires (default 60 min); clients must refresh via `POST /api/v1/login` with username/password (default `freqtrade` / `freqtrade`).

**Gotcha**: the webserver's `backtest` API **mutates the sidecar state** and may collide with the live dry-run. Per Freqtrade best practice, run the webserver in `initial_state: stopped` (already configured in our `config.json`) and never start the actual dry-run bot from the webserver; the bot is only used as a backtest/analysis tool.

### 3.4 Hyperopt — `freqtrade hyperopt` (optional, for v6.1+)

Bayesian / epoch-based search over strategy parameter spaces. Useful for hardening the in-house regime-aware strategies, but **not** required for the initial integration. Excluded from this plan's critical path; included as a future-work bullet.

---

## 4. Integration Bottlenecks

| # | Bottleneck | Impact | Mitigation |
|---|---|---|---|
| B1 | **Long-running CLI calls** — `download-data` for 4y × 50 pairs can take 20+ min; `backtesting` 5–10 min. | Cannot run inline in the Express request. | Wrap in BullMQ `freqtradeDataQueue` + `freqtradeBacktestQueue` with status polling. |
| B2 | **Language boundary** — Python child process vs Node parent. | Spawn, stdout/stderr capture, exit-code handling, signal propagation. | Use `child_process.spawn` with a thin `FreqtradeBridge` wrapper; capture stdout line-by-line and re-emit as structured logs. Use `stdio: 'inherit'` only for human-facing CLI; use `stdio: 'pipe'` for API/queue workers. |
| B3 | **Auth token management** — Freqtrade JWT vs Shady Trader's `x-api-token` / `Bearer`. | Two unrelated auth systems; risk of one being a backdoor. | Reuse `API_TRADER_TOKEN` / `API_ADMIN_TOKEN` as the Freqtrade `username`/`password` in `config.json` so the two are aligned. Never expose the Freqtrade webserver to the public internet — bind to `127.0.0.1` (already done in `config.json`). |
| B4 | **Data-format mismatch** — Freqtrade writes feather/parquet under `user_data/data/`; the in-house engine reads from `candles` SQLite table. | Two separate data stores; out-of-sync risk. | Add a `bulk_ingest_candles_from_freqtrade.py` script that scans `user_data/data/<exchange>/*.feather` and inserts into the SQLite `candles` table using the existing `runQuery` helper. Idempotent on `(symbol, timeframe, time)`. |
| B5 | **Indicator cache poisoning** — Freqtrade caches indicators on disk keyed by strategy hash. | Stale results when strategies change. | Always pass `--cache none` in CI/backtest scripts. Set `FREQTRADE_CACHE_DIR=/tmp/freqtrade_cache_${BUILD_ID}` per job in CI. |
| B6 | **Storage growth** — 1m data is heavy (8–12 GB for 4y × 50 pairs). | Local disk pressure; container image bloat. | Mount `user_data/data/` on a persistent volume (k8s PVC; docker named volume locally). Add a `.gitignore` entry (already excluded by `*.db`, but add `user_data/data/` explicitly). |
| B7 | **Strategy translation fidelity** — the in-house regime-aware strategy uses a multi-step pipeline (indicator → regime → signal → shadow trade) that doesn't map 1:1 onto Freqtrade's `IStrategy` class. | Translated strategy will produce different results. | Maintain two separate strategy definitions: (a) the in-house TypeScript pipeline (canonical for live/paper trading) and (b) a Freqtrade `ShadyTraderReferenceStrategy` Python file whose only purpose is to **validate** the in-house pipeline. Use the reference strategy to backtest a single shared timerange and assert the trade ledger is within ±5% of the in-house backtest (configurable tolerance). |
| B8 | **Silent 4xx / rate-limit failures** — Freqtrade may emit warnings (rate limits, missing trades) without non-zero exit code. | Stalled downloads/backtests without clear failure. | Pipe stdout to a regex-based line scanner; if any `WARNING\|ERROR\|Traceback` line appears, mark the job as `failed_with_warnings`. |
| B9 | **Concurrent bot/webserver** — Running the sidecar webserver while a long `backtesting` job is in flight may lock the user_data directory. | Webserver returns 503 or stale data. | Serialise all `backtesting` and `download-data` jobs through a single BullMQ worker with `concurrency: 1`. The webserver remains available for read-only `info`/`ping` calls. |
| B10 | **Python version drift** — freqtrade 2026.5.x requires Python 3.11+; macOS/Ubuntu LTS may ship 3.10. | `install_freqtrade.sh` aborts. | Already mitigated by `install_freqtrade.sh` (selects 3.11/3.12/3.13). Add a CI step that runs `python3 --version` and fails fast on <3.11. |
| B11 | **First-run backtest disk pressure** — the indicator cache can grow to 1–2 GB before being pruned. | Out-of-disk failures on small CI runners. | Set `FREQTRADE_CACHE_DIR=/tmp/freqtrade_cache` and add a `rm -rf $FREQTRADE_CACHE_DIR` step in CI between runs. |
| B12 | **Source-deny list interaction** — `server.ts` already blocks `/backend/**` and `/node_modules/**` from the SPA. | The Freqtrade webserver is on a separate port (8081), so SPA source-deny doesn't apply. | No action needed. Document the port separation in this file. |

---

## 5. Integration Architecture

```
+------------------------+     +------------------------+     +------------------------+
|  React Frontend (3000) |---->|  Express API (3000)    |---->|  FreqtradeBridge (TS)  |
|  - "Bulk Download" btn |     |  /api/freqtrade/*      |     |  child_process.spawn   |
|  - "Validate Backtest" |     |  - admin/trader auth   |     |  - venv activation     |
+------------------------+     |  - Zod validation      |     |  - stdout capture      |
                               |  - job-queue dispatch  |     |  - exit code check     |
                               +-----------+------------+     +-----------+------------+
                                           |                              |
                                           v                              v
                                +------------------------+     +------------------------+
                                |  BullMQ Queues         |     |  Freqtrade CLI (8081)  |
                                |  freqtradeDataQueue    |     |  - backtesting         |
                                |  freqtradeBacktestQueue|     |  - download-data       |
                                |  freqtradeValidateQueue|    |  - webserver (info)    |
                                +-----------+------------+     +-----------+------------+
                                           |                              |
                                           v                              v
                                +------------------------+     +------------------------+
                                |  Redis (caching,       |     |  user_data/            |
                                |   job state, rate      |     |  - strategies/         |
                                |   limit coordination)  |     |  - data/ (Parquet)     |
                                +------------------------+     |  - backtest_results/   |
                                                               +------------------------+
```
**Key design principles**:
1. **Sidecar, not replacement** — Freqtrade runs alongside the TypeScript engine; the live/paper trading loop never depends on the Freqtrade process.
2. **CLI over REST** — Use the Python CLI directly (not the REST webserver) for `backtesting` and `download-data`. The webserver is only used for `ping` / `info` and the optional `available_pairs` lookup.
3. **Job-queue isolation** — All long-running Freqtrade calls go through BullMQ with status tracking, cancellation tokens, and dead-letter handling.
4. **Idempotency** — `download-data` invocations deduplicate on `(exchange, pair, timeframe, start, end)` hash. `backtesting` invocations deduplicate on `(strategy, timerange, configHash)` so a retry uses the cached result.
5. **Data lake** — Freqtrade's `user_data/data/` is the source of truth for bulk historical data; the SQLite `candles` table is the operational cache. The bulk-ingest script reconciles the two.

---

## 6. Step-by-Step Implementation Roadmap

Total: **8 phases**, each independently shippable. Phase 0 is a one-evening bootstrap; Phases 1–4 are the critical path; Phases 5–8 are polish/optimization.

### Phase 0 — Bootstrap (already partially complete)

**Goal**: Install the sidecar, verify the smoke test, and ensure the webserver can start.

| Step | Action | Done when |
|---|---|---|
| 0.1 | `npm run freqtrade:install` (creates `backend/freqtrade/venv`) | `venv/bin/freqtrade --version` prints `freqtrade 2026.5.1` |
| 0.2 | `npm run freqtrade:up` | `curl http://127.0.0.1:8081/api/v1/ping` returns `pong` |
| 0.3 | `npm run freqtrade:smoke` exits 0 | Smoke test passes |
| 0.4 | Pin `FREQTRADE_JWT_SECRET_KEY` in `.env` to survive restarts | Sidecar starts with stable session |

**Files affected**: `backend/freqtrade/requirements.txt`, `backend/freqtrade/start_server.sh`, `backend/freqtrade/user_data/config.json`, `.env.example`, `AGENTS.md`.

### Phase 1 — Reference Strategy (the canonical validation target)

**Goal**: Author a Freqtrade `IStrategy` that mirrors the in-house pipeline as closely as possible, so backtests from both systems can be cross-validated.

| Step | Action | Files |
|---|---|---|
| 1.1 | Author `backend/freqtrade/user_data/strategies/ShadyTraderReferenceStrategy.py` (INTERFACE_VERSION=3, futures mode, ema/rsi/macd/boll/atr-via-ta-lib, minimal_roi + stoploss + trailing_stop) | new file |
| 1.2 | Add docstring explaining: this strategy is for **validation only**, not live trading; param values mirror `DEFAULT_RISK_CONFIGS[mode]` for the matching risk mode | new file |
| 1.3 | Add unit-style test that `freqtrade list-strategies` discovers it | `tests/freqtrade/list_strategies.test.ts` |
| 1.4 | Document the translation matrix (in-house `RiskMode` ↔ Freqtrade strategy params) | `documentation/upgrades/freqtrade_strategy_translation.md` |

**Acceptance**: `freqtrade list-strategies -c user_data/config.json` shows `ShadyTraderReferenceStrategy`.

### Phase 2 — Bridge Module (TypeScript ↔ Python)

**Goal**: A typed TS class that spawns Freqtrade CLI processes, captures stdout, surfaces errors, and returns structured results.

| Step | Action | Files |
|---|---|---|
| 2.1 | Create `backend/freqtrade/bridge.ts` with `FreqtradeBridge` class | new file |
| 2.2 | Implement `downloadData({exchange, pairs, timeframes, timerange, tradingMode, dataFormat})` returning a stream of `DownloadProgress` events | new file |
| 2.3 | Implement `runBacktest({strategy, timerange, pairs, timeframe, dryRunWallet, fee})` returning `BacktestResult` (parsed from JSON export) | new file |
| 2.4 | Implement `ping()` and `listStrategies()` (thin shell-out to `freqtrade <sub> --help` and `list-strategies`) | new file |
| 2.5 | Add Zod schemas for input validation and result parsing | new file |
| 2.6 | Emit structured logs (correlation ID, exchange, duration, exit code) | new file |
| 2.7 | Unit tests using mocked `child_process.spawn` (verify arg construction, stdout parsing, exit-code handling) | new tests |

**Acceptance**: `FreqtradeBridge` has 90%+ unit test coverage; `npm run lint` passes.

### Phase 3 — Job Queue Wiring (BullMQ)

**Goal**: Async execution of long-running Freqtrade commands; status visible in the existing diagnostics endpoint.

| Step | Action | Files |
|---|---|---|
| 3.1 | Add `freqtradeDataQueue`, `freqtradeBacktestQueue`, `freqtradeValidateQueue` to `backend/job_queues.ts` | edit |
| 3.2 | Add `FREQTRADE_QUEUES` to the existing `getQueueHealth()` snapshot | edit |
| 3.3 | Implement `processFreqtradeDataJob(job)` (calls `bridge.downloadData`) and `processFreqtradeBacktestJob(job)` | new files in `backend/freqtrade/workers/` |
| 3.4 | Wire workers into `TradingEngine.startSchedulers()` (idempotent; only registers if Freqtrade is installed) | edit `backend/main.ts` |
| 3.5 | Add `cancel` job API: `POST /api/freqtrade/jobs/:id/cancel` (trader-auth) → `job.remove()` | edit `backend/api/routes.ts` |
| 3.6 | Persist job state to SQLite `freqtrade_jobs` table (id, type, status, started, completed, error) | migration |
| 3.7 | Surface last 20 jobs in `GET /api/freqtrade/jobs` (trader-auth) | edit |

**Acceptance**: Submitting a job from the API completes asynchronously; status visible in `getQueueHealth()`.

### Phase 4 — API Surface (Express routes)

**Goal**: Trader/admin can trigger downloads and backtests, list available data, and reconcile results — all from the existing dashboard auth context.

| Step | Action | Files |
|---|---|---|
| 4.1 | `POST /api/freqtrade/download-data` (admin) — body: `{exchange, pairs[], timeframes[], timerange, tradingMode, dataFormat}`; enqueues `freqtradeDataQueue`; returns `{jobId}` | edit `backend/api/routes.ts` |
| 4.2 | `POST /api/freqtrade/backtest` (admin) — body: `{strategy, timerange, pairs, timeframe, mode, dryRunWallet, fee}`; enqueues `freqtradeBacktestQueue`; returns `{jobId}` | edit |
| 4.3 | `POST /api/freqtrade/validate` (admin) — runs the in-house backtest AND a Freqtrade backtest in parallel for the same timerange; returns side-by-side metrics + delta + pass/fail (tolerance configurable via `FREQTRADE_VALIDATE_TOLERANCE` env, default 5%) | edit |
| 4.4 | `GET /api/freqtrade/pairs?exchange=binance&tradingMode=futures` — proxies `freqtrade list-data` output | edit |
| 4.5 | `GET /api/freqtrade/info` — proxies `freqtrade info` (version, exchange availability) | edit |
| 4.6 | `GET /api/freqtrade/jobs` and `GET /api/freqtrade/jobs/:id` (trader) — job list/status from SQLite | edit |
| 4.7 | `POST /api/freqtrade/ingest` (admin) — runs `bulk_ingest_candles_from_freqtrade.py` to push data from `user_data/data/` into the SQLite `candles` table | edit |
| 4.8 | All routes: Zod-validated input, idempotency-key supported where mutating, role-based auth | edit |
| 4.9 | Add new routes to `traderRoutes` / `adminRoutes` lists | edit |

**Acceptance**: All 7 routes return correct responses; the `validate` endpoint produces a structured diff; the existing 300-test suite still passes.

### Phase 5 — Bulk Ingest Script (data lake → operational cache)

**Goal**: After `download-data`, push the Parquet/Feather files into the SQLite `candles` table so the live engine can use them.

| Step | Action | Files |
|---|---|---|
| 5.1 | Author `backend/freqtrade/scripts/bulk_ingest_candles.py` | new file |
| 5.2 | Walk `user_data/data/<exchange>/`, parse `*-{timeframe}.feather` (and `.parquet`), transform to `{time, open, high, low, close, volume}` | new file |
| 5.3 | Insert into SQLite `candles` table using `INSERT OR IGNORE` for idempotency | new file |
| 5.4 | Emit progress to stdout (`{pair}: {rows_inserted}/{total}`) | new file |
| 5.5 | Add `npm run freqtrade:ingest` script | edit `package.json` |
| 5.6 | Unit tests on a fixture directory with 3 synthetic feather files | new tests |
| 5.7 | Document the supported data formats + known limitations | `documentation/upgrades/freqtrade_integration_plan.md` (this file, §9) |

**Acceptance**: Running the script after `freqtrade download-data` populates the `candles` table; `getCandles()` reads the new rows on the next cycle.

### Phase 6 — Frontend UI (React)

**Goal**: A dedicated "Freqtrade" panel in the dashboard that surfaces available data, lets the user trigger downloads/backtests, and shows validation deltas.

| Step | Action | Files |
|---|---|---|
| 6.1 | Create `src/components/FreqtradePanel.tsx` with three tabs: Data, Backtest, Validate | new file |
| 6.2 | **Data tab**: list of `(exchange, pair, timeframe)` available; "Download" button per row; status pill for in-flight jobs | new file |
| 6.3 | **Backtest tab**: form (strategy dropdown, timerange picker, dry-run wallet); submit button; result table on completion | new file |
| 6.4 | **Validate tab**: shows side-by-side in-house vs Freqtrade metrics with tolerance highlighting (green if within, red if outside) | new file |
| 6.5 | Add to main App navigation (gear-icon menu → "Freqtrade") | edit `src/App.tsx` |
| 6.6 | Polling: refresh job status every 2s while a job is in flight; stop polling on completion | new file |
| 6.7 | Use existing `safeFetch` wrapper (with auth + dedup + 5s LRU cache) | new file |

**Acceptance**: Triggering a download from the UI works end-to-end; the result appears in the in-app panel within 30s of completion.

### Phase 7 — Operational Hardening (deployment, CI, monitoring)

| Step | Action | Files |
|---|---|---|
| 7.1 | Add `freqtrade` container to `docker-compose.yml` (extends `Dockerfile` with `pip install -r backend/freqtrade/requirements.txt` and a venv pre-bake) | edit |
| 7.2 | Add `FreqtradeBridge` availability to `getQueueHealth()`; expose `freqtradeInstalled: boolean`, `freqtradeVersion: string`, `freqtradeUptimeSec: number` in `/api/diagnostics/health` | edit |
| 7.3 | Add Prometheus metrics: `freqtrade_jobs_total{type,status}`, `freqtrade_job_duration_seconds_bucket{type}`, `freqtrade_data_bytes_total{exchange}` | new file |
| 7.4 | k8s: provision a **separate `freqtrade-data` PVC** (50 GB, `ReadWriteOnce` for the sidecar pod, `ReadOnlyMany` for the engine pod) per the storage decision in §12 — *not* a shared PVC on the trading-engine pod. Sidecar container stays in the trading-engine pod (`cpu: 500m / mem: 1Gi`); the **data** is on its own PVC. | edit `k8s/pvc.yaml`, `k8s/deployment.yaml` |
| 7.5 | CI step `quality:ci` runs the in-house backtest AND the Freqtrade backtest on a 30-day fixture; fails if delta > `FREQTRADE_VALIDATE_TOLERANCE` (5%, confirmed decision in §12) on Sharpe or MDD | edit `.github/workflows/ci.yml` |
| 7.6 | Add `FREQTRADE_UPGRADE.md` runbook: bump pin in `requirements.txt`, run `npm run freqtrade:upgrade`, diff the `freqtrade` API_VERSION constant in any TypeScript wrapper, update Zod schemas if needed | new file |

**Acceptance**: CI step enforces pipeline accuracy; k8s rollout succeeds; Prometheus dashboards show Freqtrade metrics.

### Phase 8 — CLI Integration

| Step | Action | Files |
|---|---|---|
| 8.1 | Add `freqtrade` subcommand to `cli/src/index.ts` (via Commander) with verbs: `download`, `backtest`, `validate`, `jobs`, `cancel` | edit `cli/src/` |
| 8.2 | Each verb calls the same Express API endpoints via `cli/src/utils/api.ts` (so no logic duplication) | edit |
| 8.3 | Add `npm run freqtrade:cli -- <verb> <args>` shortcut | edit `package.json` |
| 8.4 | TUI mode (`--watch`) for live job monitoring via blessed-contrib | edit `cli/src/commands/monitor.ts` |

**Acceptance**: `npm run freqtrade:cli -- backtest --strategy ShadyTraderReferenceStrategy --timerange 20240101-20241231` returns the same metrics as the equivalent API call.

---

## 7. Configuration Reference (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `FREQTRADE_LISTEN_PORT` | `8081` | Webserver port (matches `user_data/config.json`) |
| `FREQTRADE_JWT_SECRET_KEY` | (auto-generated if unset) | Persistent session across restarts; **set in `.env` for prod** |
| `FREQTRADE_API_USER` | `freqtrade` | Webserver login; align with `API_TRADER_TOKEN` (B3 mitigation) |
| `FREQTRADE_API_PASS` | `freqtrade` | Webserver password; align with `API_TRADER_TOKEN` (B3 mitigation) |
| `FREQTRADE_VALIDATE_TOLERANCE` | `0.05` | Allowed delta (fraction) for the `validate` endpoint. **Confirmed: 5%** (decision log §12); tighten to 3% in a v6.2 follow-up once 1y validation windows with 200+ trades are available. |
| `FREQTRADE_CACHE_DIR` | `/tmp/freqtrade_cache` | Override default indicator cache location (B5/B11) |
| `FREQTRADE_DATA_DIR` | `backend/freqtrade/user_data/data` | Override default data lake location (B6) |
| `FREQTRADE_QUEUE_CONCURRENCY` | `1` | BullMQ worker concurrency for data/backtest jobs (B9) |
| `FREQTRADE_JOB_TTL_DAYS` | `7` | Days to keep `freqtrade_jobs` rows before pruning |
| `FREQTRADE_AUTO_INSTALL` | `false` | If `true`, the npm postinstall hook runs `install_freqtrade.sh` (off by default to keep CI clean) |

---

## 8. Testing Strategy

| Layer | Tool | Coverage target |
|---|---|---|
| Bridge unit (mocked spawn) | `tsx --test tests/freqtrade/bridge.test.ts` | 90% lines |
| Strategy discovery | shell + TS | 100% (single integration test) |
| Job queue integration | Real BullMQ + mocked Freqtrade CLI | 80% lines |
| API route validation | supertest + Zod | 100% of happy + sad paths |
| CLI smoke | bash + `npm run freqtrade:cli -- ping` | always green |
| End-to-end (Playwright) | Existing `tests/playwright/trading-system.spec.ts` extended with a "Freqtrade" story | 1 happy + 1 sad |
| Reconciliation (validate) | Runs both backtests on 30-day fixture; asserts Sharpe delta < 5% | 100% deterministic |
| Load test | 10 concurrent download jobs queued; assert serialised execution (B9) | 1 test |

**Critical regression test** (run in CI):
```
# Pseudocode
const inHouse = await runInHouseBacktest('BTC/USDT', '20240601', '20240701')
const ft = await runFreqtradeBacktest('ShadyTraderReferenceStrategy', '20240601', '20240701')
assert abs(inHouse.sharpe - ft.sharpe) / inHouse.sharpe < 0.05
assert abs(inHouse.mdd - ft.mdd) / inHouse.mdd < 0.10
assert inHouse.tradeCount > 5
```

---

## 9. Data Format Conformance (Freqtrade → in-house `candles` table)

| Freqtrade column | In-house column | Transform |
|---|---|---|
| `date` (ms epoch) | `time` (ms epoch) | direct |
| `open` | `open` | float |
| `high` | `high` | float |
| `low` | `low` | float |
| `close` | `close` | float |
| `volume` | `volume` | float; Freqtrade spot volume may be base currency, futures may be quote — we use quote by default and tag with `volume_currency` |
| `*-futures.feather` | not stored | funding rate; out of scope for v6.1 (future) |
| `*-mark.feather` | not stored | mark price; out of scope for v6.1 (future) |

**Known limitations**:
1. **Spot vs futures volume currency** — Spot: `volume` is base (e.g. BTC). Futures: `volume` is quote (USDT). Our `volume` column assumes quote. For spot, multiply `volume * vwap(close, open)` to normalize.
2. **Timeframe alignment** — Freqtrade resamples 1m to 5m/15m/1h at the source; if our in-house `aggregateFromBaseTimeframe()` is also running, the two may disagree by a few seconds on candle boundaries. The validate test should use only Freqtrade-sourced data when comparing trade timestamps.
3. **Pair naming** — Freqtrade's `BTC/USDT:USDT` (futures) → in-house `BTC/USDT` (single column). The transform drops the `:USDT` suffix and tags the row with `trading_mode='futures'`.
4. **Parquet support** — `pyarrow` is required for parquet. `requirements.txt` already pulls it via `freqtrade[plotting]`, but verify with `python3 -c "import pyarrow"` after install.

---

## 10. Future Work (v6.1+)

These items are **explicitly out of scope** for the v6.0 integration but documented so they don't get lost.

| Item | Why deferred | Target version |
|---|---|---|
| `freqtrade hyperopt` integration | Requires schema for strategy param space; v6.0 has no formal `HyperoptableStrategy` base. | v6.1 |
| FreqUI embedding | The webserver already serves FreqUI on port 8081, but our `source-deny` middleware in `server.ts` doesn't know about it. Would require either (a) nginx path-prefix routing, or (b) an iframe proxy. | v6.2 |
| Live-trade reconciliation | The sidecar's `/api/v1/trades` is a dry-run stream; reconciling it with the in-house `shadow_trades` table would require a state-differ worker. Useful but not on the critical path. | v6.2 |
| Funding-rate and mark-price ingestion | The data lake format already supports it (`*-futures.feather`, `*-mark.feather`); we just don't have a `funding_rates` table yet. | v6.2 |
| Cross-exchange arbitrage | Freqtrade supports pairlists that span exchanges; our `regime detector` doesn't have a cross-exchange mode. | v6.3 |
| Walk-forward analysis | Freqtrade has `freqtrade walk-forward` (beta in 2026.5.x). Our `backend/validation/wfa/rolling-optimizer.ts` already does this in-house; cross-validate later. | v6.3 |
| Multi-account dry-run | Freqtrade supports multiple `trading_mode` instances pointing at different configs. Useful for stress-testing the 6 risk modes simultaneously. | v6.4 |

---

## 11. Summary

| Dimension | In-house today | After integration |
|---|---|---|
| Historical data sources | 1 primary + 2 fallbacks (CC + CG) | 1 primary + 17+ Freqtrade exchanges |
| Bulk data download | Manual (max ~1000 candles/call) | `freqtrade download-data` with rate-limit awareness |
| Data formats | JSON-via-REST, daily-only fallback | Parquet / Feather (5–10× faster); futures mark + funding |
| Backtester | TS in-process, single strategy | TS in-process + Python reference, cross-validated |
| Backtest output | Inline JSON to API caller | Async job → SQLite job table → pollable |
| Multi-strategy comparison | Manual | `freqtrade backtesting --strategy-list` |
| Hyperopt | None | `freqtrade hyperopt` (v6.1) |
| UI surface | One "Backtest" button in dashboard | Dedicated "Freqtrade" panel (Data / Backtest / Validate tabs) |
| CI gate | n/a | Reconcile test (Sharpe Δ < 5%, MDD Δ < 10%) |

**Net cost**: ~3 engineer-weeks across 8 phases for the critical path (Phases 1–4). Phase 0 is already ~80% done (the scaffold exists). Phase 5 is one Python file. Phases 6–8 are polish.

**Net benefit**: industry-standard historical data acquisition, a 17-exchange multi-strategy backtest harness, and a permanent, automated cross-validation of the in-house indicator→regime→signal pipeline. The live trading path remains untouched.

---

## 12. Decisions Log (resolved 4 June 2026)

All seven open questions have been resolved by the project owner. Each decision is reflected in the relevant upstream sections (notably §6 Phase 7.4/7.5 and §7 env-var row).

| # | Question | Decision | Rationale (summary) | Where it shows up in this plan |
|---|---|---|---|---|
| 1 | Tolerance target | **5%** (`FREQTRADE_VALIDATE_TOLERANCE=0.05`) | Honest model diff between pandas and TS pipelines; matches existing `quality:ci` coverage tolerance; standard error of Sharpe on 30 trades (~0.18) makes 5% safe. | §7 env-var row; §8 critical regression test; §6 Phase 7.5 |
| 2 | Default exchange | **User-configurable** (via existing settings modal) | Settings modal already accepts `exchange`/`apiKey`/`apiSecret`/`apiPassword`; mirror the `${EXCHANGE_NAME:-binance}` pattern from `backend/exchange/connector.ts:561`. | §6 Phase 0.4 (config wiring) |
| 3 | Storage budget | **Separate `freqtrade-data` PVC** (50 GB, RW for sidecar, RO for engine) | Lifecycle decoupling; safety-by-default (read-only mount for the engine pod); HPA-friendly; one-time $2/mo cost; independent backup/retention. | §6 Phase 7.4 |
| 4 | Strategy sharing | **No** — keep `ShadyTraderReferenceStrategy.py` internal | Upstream maintenance burden across future Freqtrade releases; no public API contract; plan doc already serves as the public description. | (No plan section — pure "don't do this") |
| 5 | Hyperopt scope | **`stoploss` + `minimal_roi`** for the 6 risk modes | Lowest-risk first cut; expands in v6.2 once a HyperoptableStrategy base exists. | §10 Future Work |
| 6 | Run cadence | **Weekly** (Sunday 03:00 UTC) | Stays well under exchange rate limits; aligns with the v6.0 hourly `fetch-market-data` cycle; parquet storage churn ~50 MB/pair/week. | §6 Phase 3 (new BullMQ cron job) |
| 7 | FreqUI access | **Embed** behind trader auth via express reverse proxy (`/freqtrade/*` → `http://127.0.0.1:8081`) | Single sign-on; inherits existing auth/CSP/helmet/rate-limit; ~30 lines of code; one-line WS token-check relaxation for the proxied upgrade path. | (Future work, after Phase 4 ships; the reverse-proxy goop lives in `server.ts`) |

---

*End of plan. Implementation begins at Phase 0.4 (env pinning) and Phase 1 (reference strategy) once this document is reviewed.*
