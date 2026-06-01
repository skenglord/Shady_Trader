# Shady Bot — Strategy Testing & Optimization CLI

A terminal control interface for the Shady Bot trading system.
Connects to the running bot via HTTP/WebSocket and reads the DB directly via better-sqlite3.

## Usage
```bash
npm run trading-cli -- <command>
npm run cli:status      # engine health
npm run cli:monitor     # TUI dashboard
npm run cli:backtest    # run a backtest
```

Built incrementally:
- Wave 2 (14-core): config, engine, db, logs, monitor
- Wave 7 (14-panels): regime, ratchet, bayesian, ml panels
