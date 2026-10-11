# Shady Trader system audit — 10 October 2026

Audited commit: `26c909ee89e3102f9203f565d9f35d8153d717da`. The working tree was clean at the start. This report supersedes historical readiness assertions; it does not certify a deployed instance.

**Assessment: not ready for live funds or untrusted network exposure.** Current source contains reproducible authentication, execution, and accounting failures. Successful compilation and existing tests do not cover these failure paths. Paper results also contain material accounting defects, so they should not be used as evidence of strategy performance until corrected.

This was an audit, not an implementation pass. Repository changes are documentation/evidence only. No live orders, production database mutations, deployments, or credential changes were performed. One mock harness appended audit messages to the application's existing log; those entries were preserved. A mispatched mock attempted a request using dummy credentials, failed DNS before reaching the exchange, and was rerun with a hard network guard. Details are in the trading appendix.

## Scope and method

Reviewed server/REST/WebSocket access controls, frontend/CLI, engine lifecycle, shadow and paper execution, risk/balance accounting, exchange reconciliation, SQLite/PostgreSQL schemas, backups, market-data boundaries, strategy/research/ML/Freqtrade, Docker/Kubernetes, CI and dependency advisories. Parallel reviewers covered independent domains. Historical Hermes and readiness documents were treated as leads, not proof.

Tests/builds ran in `/tmp/shady-audit-20261010`, a clean Git archive with the existing installed dependency directory linked in. No operator `.env` or database was copied. Test flags disabled live trading, ML/Gemma/Freqtrade and PostgreSQL; Redis was directed to unused port 6399. This validates the installed dependency set, not a fresh `npm ci` installation. Native SQLite dependencies require the installed Node 22 runtime; the default Node 24 shell has an ABI mismatch. The serial run used `NODE_OPTIONS=` to avoid host-level instrumentation injection and `LOG_DIR=/tmp/shady-audit-logs` for isolated logs.

Detailed evidence: [security and deployment](audits/2026-10-10/security.md), [trading and accounting](audits/2026-10-10/trading.md), [research and databases](audits/2026-10-10/research-and-data.md), [npm advisory response](audits/2026-10-10/npm-audit.json).

## Verification results

| Check | Result and limits |
| --- | --- |
| Root TypeScript check (`npm run lint`) | PASS, exit 0 |
| Production frontend (`npm run build`) | PASS, exit 0; largest emitted chunk 332.43 kB |
| Complexity gate | PASS, configured maximum 50; only the four files listed in the checker are measured |
| Isolated Chromium frontend checks | PASS, 2/2; API/WebSocket fixtures, not live backend integration |
| Serial Node 22 tests + coverage | PASS, exit 0: 518 tests, 517 passed, 0 failed/cancelled, 1 skipped; lines 56.97%, branches 74.68%; coverage checker passes |
| Root-level `tests/ml.test.ts` | PASS, 28/28; separately run because the shell-expanded standard test glob omits it |
| CLI-specific TypeScript project | FAIL, TS6059: imports from `backend/` lie outside `cli/src` rootDir |
| Production dependency audit | FAIL: 12 affected packages — 1 critical, 2 high, 9 moderate |
| Repository whitespace/diff check | PASS, `git diff --check` |
| Existing local service | Connection refused at `127.0.0.1:3000`, including outside sandbox; deployed runtime health not established |
| Docker startup | Missing `seed.js` reproduced using a temporary copy of the final image's source-file layout; no Docker daemon build performed |
| Kubernetes | Source/YAML checks found undefined volume mounts and conflicting replica configuration; no cluster deployment attempted |

Sandbox IPC/listening restrictions initially prevented TSX and browser execution. Those checks were rerun with approved escalation. Such restrictions are not application failures. The Node 24 ABI issue is an environment mismatch, not proof of a database logic defect.

The Node 24 run exited 1 with 21 cancelled tests caused by native SQLite load failures (496 passed, 1 skipped). Node 22 resolved those cancellations. Node 22 coverage used a separate c8 report/raw-data directory. The [coverage summary](audits/2026-10-10/coverage-summary.json) covers backend TypeScript under the repository's `.nycrc` rules; it excludes the frontend and Python. TAP also contains 38 skip records, including whole quarantined suites; the final one-skipped *test* counter does not communicate those unexecuted suites. These include reconciliation, WFA, optimiser, paper controller and performance suites. Other focused tests cover parts of some of those modules, but do not substitute for the skipped scenarios.

## Findings ordered by remediation priority

P1 means release-blocking for the affected feature/exposure; P2 means a material correctness or operational defect. “Reproduced” means an isolated deterministic harness; “source” means a traced code path without exercising a real exchange or deployed cluster. Related defects are grouped to avoid counting the same root cause repeatedly.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| S1 | P1 | Unauthenticated WebSocket JSON `null` throws outside the parse guard and reaches the process-exit handler | Reproduced; `backend/api/websocket.ts:71`, `server.ts:523` |
| S2 | P1 | REST `/symbol` and `/paper` lack role middleware; an arbitrary token header bypasses CSRF without authenticating | Source; `backend/api/routes.ts:480`, `:509`, `:809`; security appendix |
| S3 | P1 | Paper-trading WebSocket sends positions/P&L before authentication | Reproduced; `backend/main.ts:369`, `backend/paper-trading/websocket-handler.ts:37` |
| S4 | P1 | Development file denial can be bypassed through Vite `/@fs/` and encoded paths; root database files are also served | Reproduced with source/sentinel file only; `server.ts:468`; security appendix |
| T1 | P1 | Live close timeout/partial-fill/concurrency paths can submit duplicate full orders and settle P&L twice | Reproduced; `backend/shadow/shadow_trader.ts:541`, `:667` |
| T2 | P1 | Switching pair applies the new pair's price to old positions, potentially triggering real exits and false P&L | Reproduced BTC/ETH case; `backend/main.ts:922`, `:1297`, `backend/shadow/shadow_trader.ts:602` |
| T3 | P1 | Stop/kill can return while an entry inside awaited work later submits a live order | Reproduced; `backend/main.ts:1278`, `backend/shadow/shadow_trader.ts:242`, `:380` |
| T4 | P1 | Reconciliation reads stubbed empty positions and cannot recover uncertain entry intents | Reproduced stubs + traced recovery path; `backend/exchange/connector.ts:103`, `backend/exchange/adapter.ts:177` |
| T5 | P1 | Accepted Kraken orders are always normalized as `open`, rejected by the strict full-fill guard, with no status recovery | Reproduced placement response; `backend/exchange/connector.ts:776`, `backend/shadow/shadow_trader.ts:26` |
| T6 | P1 | Concurrent balance updates overwrite reservations/results; closure settlement is not awaited | Reproduced lost $1,000 reservation; `backend/balance/manager.ts:61`, `:156`, `backend/shadow/shadow_trader.ts:698` |
| T7 | P1/P2 | Runner partial exits shrink local quantity and credit profit without exchange execution or durable position update | Reproduced; `backend/shadow/shadow_trader.ts:441`; live requires runner-enabled compatible/legacy position, simulation affected by default |
| T8 | P2 | Pair/timeframe setters preserve the active cycle token; old work can continue after a configuration switch | Reproduced; `backend/main.ts:913` |
| T9 | P2 | Loss streak halts cannot recover through the documented reduced-size trading path and are erased by restart | Reproduced; `backend/risk/manager.ts:247`, `:508` |
| P1 | P1 | Paper order/position IDs differ; market positions open before fill with entry price zero and never receive the actual entry fill | Reproduced; details below |
| P2 | P1 | Paper P&L divides by leverage, profitable moves can liquidate positions, and liquidation records zero realized loss | Reproduced; details below |
| R1 | P1 | Failed optimisation mutates active risk parameters before persistence/validation | Reproduced leverage 1→8.2 despite failure; `backend/strategy/optimization_engine.ts:91` |
| R2 | P1 | Optional LLM synchronously chooses active risk mode; narrative calls also delay position processing | Source; `backend/main.ts:1071`, `:1112`; violates explicit project AI rules |
| R3 | P2 | ML row reads use write-query mode, ESM paths reference undefined `__dirname`, and PostgreSQL ML schema differs from runtime expectations | Three separately reproduced integration blockers; research appendix |
| R4 | P2 | Freqtrade bridge expects flat JSON while installed Freqtrade exports ZIP/nested strategy results; cancellation uses a different job ID from the child | Real installed writer + schema reproduction/source; research appendix |
| R5 | P2 | WFA selects using its own OOS results; ML holdout contains fitted observations; short WFA exits use long-side levels | Source + label reproduction; research appendix; experimental tooling |
| R6 | P2 | Monte Carlo accepts model/correlation/horizon inputs that its aggregate fixed-parameter CPU simulation does not faithfully implement | Source; details below |
| O1 | P1 | Production image omits statically imported seed module; Kubernetes sidecar mounts undefined volumes | Reproduced import failure + YAML checks; security appendix |
| O2 | P1 | HPA forces 2–10 replicas despite single-owner engine design | Source; `k8s/hpa.yaml:12`, `k8s/deployment.yaml:101` |
| O3 | P1 | SQLite backup copies the main file despite WAL; PostgreSQL deployments still use SQLite backup logic | Source; `backend/backup.ts`; security appendix |
| O4 | P2 | Production dependency security gate fails | Live npm registry response; reachability qualifications below |
| U1 | P2 | Frontend treats rejected settings/risk saves as success and updates symbol/timeframe after rejection | Source; `src/App.tsx:238`, `:241`, `:244`, `:245` |
| Q1 | P2 | Default shell test glob excludes root ML tests; CLI's own TypeScript project fails | Verified test selection + compilation; details below |

## Paper-trading evidence

**P1 — order identity and fill lifecycle.** `PaperTradingService.createPaperTrade` generates `orderId` at line 200, but `PaperPositionTracker.openPosition` generates a second UUID at `position-tracker.ts:49`. The pending position is already marked open and has `entryPrice:0` for market orders (`paper-trading-service.ts:235`). `handleOrderFill` looks up the position using the order ID (`:179`), so it never finds it. Even if IDs matched, it updates current price rather than entry price/filled quantity. Cancellation likewise addresses the wrong position ID.

An isolated fixture created a one-unit market buy, matched it, and invoked the fill handler. Assertions confirmed different IDs and a zero entry price after the fill. Fix by creating positions from confirmed fills, sharing an explicit identity/mapping, handling cumulative/partial quantities, and atomically updating order/state/position. Add lifecycle assertions rather than merely checking that creation returns a pending response.

**P2 — accounting and liquidation.** At `position-tracker.ts:223`, open P&L is the difference between current and entry *margin*, dividing price gain by leverage. One unit moving 100→110 at 2× returns 5 instead of 10. `checkLiquidation` uses absolute P&L (`:201`), so a profitable move 100→150 also liquidates that long. `liquidatePosition` assigns `pnl.realizedPnl` while the position is still open (`:155`), which is zero, erasing the loss. All three results were reproduced directly. Fix quantity-based signed P&L, equity/maintenance-margin liquidation rules, and one-time realization of the actual loss. This finding concerns the separate paper-trading tracker; it does not assert the same formulas remain in the newer shadow P&L helper.

Reproducer: `/tmp/shady-audit-20261010/paper-repro.ts`, exit 0 under Node 22; no exchange or database used.

## Frontend, CLI, and simulation evidence

**U1 — misleading mutation results.** Fetch resolves normally on HTTP errors. `saveRiskConfigs` and `saveSettings` ignore `res.ok` and close their modal after 400/401/500. `changeTimeframe`/`changeSymbol` log rejected responses and still update local displayed values. A rejected risk limit or wrong pair can therefore appear applied. Only commit UI state on successful validated responses; preserve input and show the server error. The 2 passing browser tests exercise loading/chunks, not rejected mutations.

**R6 — Monte Carlo input semantics.** `backend/monte-carlo/types/index.ts:13` documents `timeHorizon` in days. `monte-carlo-engine.ts:180` uses horizon×252 steps, while `:188` sets `dt=1/timeSteps`, integrating one year for every requested horizon. It uses fixed drift 0.08 and volatility 0.25 (`:191`), aggregates all assets into a single portfolio value, and ignores selected model and supplied correlation matrix in the simulation. The API exposes these inputs as meaningful choices. Treat current results as a demonstration; implement consistent time units, chosen models, and asset covariance before relying on its risk estimates.

**Q1 — verification gaps.** `package.json` uses unquoted `tests/**/*.test.ts`. In the default shell this expands the one-directory-deep suites and excludes `tests/ml.test.ts`. Explicitly running that file found 28 passing tests absent from the normal selection. `cli/tsconfig.json:4` fixes rootDir to `src`, but CLI modules import backend source; its dedicated check fails TS6059 even though root lint passes. Use explicit recursive file discovery/runner glob semantics and keep the CLI project boundary consistent with its imports.

Reproduction commands (from the isolated snapshot):

```bash
export PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH
export NODE_OPTIONS=
npm run lint
npm run build
npm run quality:complexity
NODE_ENV=test REDIS_PORT=6399 ML_ENABLED=false GEMMA_ENABLED=false FREQTRADE_ENABLED=false LIVE_TRADING_ENABLED=false USE_POSTGRES=false LOG_DIR=/tmp/shady-audit-logs node_modules/.bin/c8 --reports-dir=coverage-node22 --reporter=text --reporter=json-summary node_modules/.bin/tsx --test --test-concurrency=1 --test-timeout=120000 tests/**/*.test.ts
LOG_DIR=/tmp/shady-audit-logs node_modules/.bin/tsx --test --test-timeout=120000 tests/ml.test.ts
node_modules/.bin/playwright test tests/playwright/lazy-dashboard.spec.ts --reporter=list
node_modules/.bin/tsc --noEmit -p cli/tsconfig.json
npm audit --omit=dev --json
```

The existing coverage gate was run against the completed Node 22 summary at its expected `coverage/coverage-summary.json` path. Full logs remain under `/tmp/shady-audit-20261010/`; no temporary test database is part of this documentation.

Additional source findings requiring acceptance tests are retained in the appendices: venue/mode changes bypassing open-position guards, actual exchange fill prices/fees not used for live P&L, a Promise broadcast instead of resolved performance, daily trade caps not enforced, default SQLite missing optimisation trials, PostgreSQL-specific query/schema issues, and simplified backtest/cross-validation metrics. These are not evidence of profitable or production-equivalent strategies.

## Dependency advisories and exposure

The fresh `npm audit --omit=dev --json` result reports 12 affected production packages (not 12 independent exploits): one critical `proxy-addr`, high `@grpc/grpc-js` and `source-map-js`, and nine moderate OpenTelemetry-related entries. The registry offers fixes; some require an OpenTelemetry version-range change. No packages were upgraded during this audit.

The critical [proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) requires an affected IPv4-mapped IPv6 trust-subnet configuration. No Express `trust proxy` configuration was found in this application, so this audit does **not** demonstrate that bypass in Shady Trader. The [gRPC advisory](https://github.com/advisories/GHSA-m9gg-hp2v-232j) concerns certificate authorization in particular server configurations; the [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) concerns processing crafted indexed source maps. No reachable hostile-input path was demonstrated for either. Upgrade and regression-test them, while prioritizing the directly reproduced application vulnerabilities above.

## Recommended sequence and exit criteria

1. **Access boundaries:** reject malformed WS frames without crashing; authenticate every REST router and WS data path; restrict development file serving by canonical path and exclude data/backups. Verify invalid/missing tokens, `null`/oversize frames, encoded paths, and alternate Vite paths in regression tests.
2. **Execution/accounting:** one durable entry/partial/full-close lifecycle, unique exchange IDs, real reconciliation, per-symbol/venue ownership, transactional settlement, and cancellation that drains or reconciles in-flight submissions. Prove timeout-after-fill, partial fill, concurrent close, DB failure, stop/kill during entry, restart, pair switch and account switch.
3. **Simulation/research:** repair paper fill/accounting, make risk activation atomic, remove LLM risk authority, fix DB/ML/Freqtrade contracts, and evaluate untouched OOS data. Prove paper/real-fill accounting equivalence using the same deterministic ledger cases.
4. **Operational release:** repair image/manifests, enforce one engine owner, implement restore-tested database backups, upgrade affected dependencies and correct CI/test selection. Run a fresh install, real PostgreSQL integration, sandbox exchange lifecycle, Freqtrade export/cancel smoke, and authenticated browser/backend tests before enabling live funds.

## Limits

No existing service was available at the configured port. No real exchange account, provider freshness, Redis failover, PostgreSQL server, order-fill recovery, production load/soak, deployed Kubernetes, restore drill, live Freqtrade backtest, or trained-model accuracy was verified. External services were not installed or started simply to produce green checks. The isolated browser suite mocks APIs; the deterministic test suite disables optional engines. Source coverage and a passing test count cannot establish profitability, exchange correctness, or production readiness.
