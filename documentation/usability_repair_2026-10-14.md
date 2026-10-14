# Local usability repairs — October 14, 2026

The October 12 audit's eleven reproduced failures have been repaired. The local application is available for authenticated human testing at **http://localhost:3001**, using real public market data and simulated execution. Live exchange orders remain disabled. This is evidence of the tested workflows, not certification for real funds or deployment on an untrusted network.

## Audit findings and repairs

| Finding | Repair and verification |
| --- | --- |
| 1. Runner profit credited twice | Partial and final settlements claim persisted remaining quantity and update cash, journal and trade atomically. SQLite tests cover same-cycle exits, restart, concurrent claims and audit rollback. |
| 2. Mode-switch wallet inflation | Persist reservation ownership and reserved margin at entry; settle the original owner's reservation regardless of current mode. Reject excess principal release. |
| 3. Incorrect completed candles | Upsert complete OHLCV and provenance together. Ticker updates no longer overwrite persisted exchange bars. All 18 live finalized-bar comparisons matched Binance across BTC, ETH and SOL / USDT, at 1m, 5m, 15m, 1h, 4h and 1d. |
| 4. Cross-symbol daily-loss valuation | Resolve each open position's own fresh symbol mark; unavailable or invalid marks block entry. |
| 5. Limit-price violations | Every depth level respects the limit. FOK availability is checked before execution; IOC cancels unfilled remainder; orders share consumed depth. |
| 6. Premature liquidation | Compare remaining equity with maintenance margin without applying leverage twice. Reject stale or wrong-symbol marks and cancel resting entry remainder on liquidation. |
| 7. Disconnected paper REST | REST and WebSocket share the engine-owned account. Persist positions, orders and idempotency records; restore after restart; roll back account and consumed depth when saving fails. |
| 8. Empty performance broadcasts | Await performance data and retain the last successful snapshot on refresh failure. Real browser observed populated frames. |
| 9. Fallback contract violations | Validate symbol, quote, interval, alignment, OHLCV, volume availability and freshness. Unsupported providers explicitly fail rather than substituting another market. Historical data remains separate from live validation. |
| 10. Misleading freshness/cache | Show actual provider and market-overview age, avoid caching mutable candle requests, include pair/timeframe, reject superseded chart responses and display unavailable data. Preserve original news publisher/time. |
| 11. Mobile overflow | Wrap controls and contain charts/tables. Actual Chromium measurement at 390px: document and body widths both 390px. |

Independent review additionally reproduced partial-entry growth during a close and lost depth on save failure; both now have passing regressions. Stream timestamps remain milliseconds in raw history and seconds only at chart rendering. Older and wrong-market frames are ignored.

## Runtime and research fixes

Redis workers now await protocol readiness, recover delayed startup, register once and reset cleanly on shutdown/restart. A private Redis integration fixture verifies job consumption; the application reports Redis healthy and registers standard and Freqtrade workers. Tests use an isolated Redis configuration so installed local services cannot silently change test behavior or receive test jobs.

Freqtrade 2026.5.1 is installed and discovers `ShadyTraderReferenceStrategy`. Fixed discovery's output format, dangling optional CLI flags, current ZIP result parsing and native strategy result normalization. Every backtest owns an output directory; missing output can no longer return an older run's result. A public Binance futures download completed for BTC/USDT:USDT 1h, September 1–October 14. The reference backtest ran September 10–October 14 with zero trades and zero warnings. This verifies execution and result transport; it does not establish profitability or strategy quality.

Closed live-trade history now reads the actual database price column and returns a JSON error on database failure. Manual entry after stopping the engine responds without waiting for the engine's entire run loop. The launcher requires the JSON readiness endpoint rather than accepting the SPA's HTML fallback. The CLI TypeScript root and recursive Node test discovery are repaired.

## Verification

- Full merge run: **667 tests, 666 passed, zero failed, one skipped** (452.6 seconds). Whole skipped suites are listed separately in [verification.json](audits/2026-10-14/verification.json); they are outside the individual skip count. Final manual-entry/accounting/paper regression checks: 38 passed.
- Root and CLI TypeScript checks, production frontend build and complexity gate pass. Three isolated Chromium scenarios pass.
- Real browser: no page errors or failed responses in the observed session, closed-history HTTP 200, populated portfolio WebSocket frames and mobile width 390/390. Nonfatal browser warnings are preserved in the evidence.
- A real-depth paper buy of 0.0001 BTC filled at 83425.02 and closed at 83425.01. Realized P&L was exactly -0.000001 USDT. Entry/close retries preserved identity and accounting. The closed account state was checked after application restart.
- [Archived evidence](audits/2026-10-14/) includes candle comparisons, browser measurements/screenshots, paper workflow and research results. No operator tokens are archived.

## Human testing and local operation

The test checkout is `/tmp/shady-trader-usability`, with its own `trading_usability.db` and private `.env`. Use the existing local operator tokens; the earlier port-3000 clone/database is preserved. Node 22 is required by the SQLite native module. After stopping an existing process, run `PORT=3001 npm run app` from the checkout to rebuild and launch it with readiness checks.

Redis core binaries are installed under `/home/creekz/.local/share/shady-trader/bin`; the local instance binds loopback port 6379 with append-only persistence in `/home/creekz/.local/share/shady-trader/redis`. Freqtrade uses `backend/freqtrade/venv` (linked to the main checkout's installed environment). Its CLI workers are enabled; a separate FreqUI webserver is not running. The private configuration keeps live trading disabled and supplies local research credentials.

ML Python dependencies import successfully from `backend/ml/venv`, but no trained model was loaded and ML remains disabled. Ollama/Gemma inference was not enabled. Training and independent out-of-sample evaluation remain prerequisites for claiming AI capability.

## Remaining release gates

Unknown ownership on legacy shadow positions is deliberately not inferred. Preserve the original database and reconcile those reservations before releasing funds or adopting its historical performance. The fresh test account avoids silently migrating uncertain ownership.

Native credentialed sandbox execution across supported venues, arbitrary external Binance symbols and third-asset fee valuation remain open. PostgreSQL integration/restore, deployment ownership, Docker/Kubernetes release checks, atomic risk-configuration activation and independent strategy/ML evaluation remain open in the readiness tracker. Existing development dependency advisories were not re-audited in this change; dependencies were not changed. These limits are separate from the verified local public-data paper workflows.
