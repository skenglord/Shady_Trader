# Shady Bot — Strategy Testing & Optimization CLI

A terminal control interface for the Shady Bot trading system.
Connects to the running bot via HTTP/WebSocket and reads the DB directly via better-sqlite3.

## Usage
```bash
npm run trading-cli -- <command>
npm run cli:status      # engine health
npm run cli:monitor     # TUI dashboard
npm run trading-cli -- engine start # real-data shadow/paper strategy loop
npm run trading-cli -- backtest --symbol BTC/USDT --fees-enabled --slippage-enabled
```

The engine CLI controls the server's shadow trader. It uses exchange market data
and does not place live orders while `LIVE_TRADING_ENABLED=false`. The generic
`backtest` command runs the in-house backtester against candles already in the
SQLite database.

### Freqtrade historical data and backtests

Install the Python runtime once, then use `--local` to run Freqtrade directly
without Redis or enabling background workers:

```bash
npm run freqtrade:install
npm run trading-cli -- freqtrade download --local
npm run trading-cli -- freqtrade ingest --local
npm run trading-cli -- backtest --symbol BTC/USDT --fees-enabled --slippage-enabled
npm run trading-cli -- freqtrade backtest --local --strategy ShadyTraderReferenceStrategy
```

With no `--timerange`, Freqtrade requests data from `FREQTRADE_HISTORY_START`
(default `20170101`) through today; each exchange/pair only returns history it
actually has. Backtests without a timerange use all downloaded candles. Defaults come
from `FREQTRADE_DEFAULT_PAIRS`, `FREQTRADE_DEFAULT_TIMEFRAMES`, and
`FREQTRADE_TRADING_MODE`; the defaults are BTC/ETH/SOL futures at 1m, 5m, 15m,
1h, 4h, and 1d. Specify `--timerange YYYYMMDD-YYYYMMDD` to narrow the range,
or `--timerange YYYYMMDD-` to download from a particular start through today.
`freqtrade ingest --local` imports those Parquet files into the SQLite candle
table for the in-house backtester. Direct Freqtrade backtests read the files
without ingestion. Public historical downloads do not need exchange account
keys; private account and live trading actions do.

The non-`--local` Freqtrade commands queue jobs through the running API and
require Redis plus `FREQTRADE_ENABLED=true`. `--local` avoids that dependency.

Built incrementally:
- Wave 2 (14-core): config, engine, db, logs, monitor
- Wave 7 (14-panels): regime, ratchet, bayesian, ml panels
