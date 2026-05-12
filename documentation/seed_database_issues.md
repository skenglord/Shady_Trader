# Seed Database: Known Issues & Logic Documentation

> **Created**: 2026-05-12  
> **Status**: Documented  
> **Author**: Auto-generated from system analysis

---

## 1. Seed Logic (`seed.ts`)

### Purpose
`seed.ts` (`seedDatabase()`) provides mock data for development and testing. It is called from `server.ts` during startup with a **best-effort** approach (failures are logged but don't crash the server).

### Table Seeding Behavior

| Table | Records Seed | Notes |
|---|---|---|
| `shadow_trades` | 60 (12 per mode × 5 modes) | 10 closed + 2 open per risk mode |
| `candles` | 1,500 (500 per symbol × 3 symbols) | 1-minute OHLCV data |
| `balances` | 0 | Set via `ShadowTrader.reset()` at engine start |
| Other tables | 0 | Empty unless populated by engine runtime |

### Seed Skip Condition (Bug History)

**Original Bug (pre-fix)**:
```typescript
// BUG: Both conditions must be true to skip
if (count.count > 0 && candleCount.count > 0) return;
// Result: 0 shadow_trades when candles exist but shadow_trades don't
```

**Fixed Condition (current)**:
```typescript
// FIX: Skip if EITHER table has data (prevents partial reseeding)
if (count.count > 0 || candleCount.count > 0) return;
// Now: 60 shadow_trades + 1500 candles on fresh start
```

**Why `OR` instead of `AND`?**
- Using `AND` allowed partial state: candles could exist (from prior run) while shadow_trades was empty → seed would skip entirely, leaving zero trades
- Using `OR` ensures any prior data prevents re-seeding, maintaining consistency
- Idempotent: repeated calls are no-ops after first successful seed

### Risk Modes in Seed Data

```typescript
const modes = ['ultra_conservative', 'conservative', 'moderate', 'aggressive', 'degen'];
```

Note: `'ai_enhanced'` mode is NOT seeded (6 modes exist in `RiskMode` enum, only 5 are seeded).

---

## 2. Database Schema: Tables & Relationships

### Core Tables (25+ tables)

| Table | Purpose | Key Columns |
|---|---|---|
| `candles` | Price/time series data | `symbol`, `timeframe`, `time`, OHLC, `volume` |
| `trades` | Live/executed trades | `id`, `symbol`, `side`, `amount`, `price`, `status` |
| `shadow_trades` | Paper trading simulation | Same as trades + `leverage`, `stop_loss`, `take_profit` |
| `balances` | Wallet accounting | `main_balance`, `bot_balance`, `active_trade_balance`, PnL |
| `settings` | Key-value config | `key`, `value` |
| `regime_history` | Regime classification log | `regime`, `confidence`, `reasoning` |
| `daily_performance` | Per-mode daily stats | `date`, `risk_mode`, `total_pnl`, `win_rate` |
| `market_data` | Aggregate market data | `market_cap`, `fear_greed_index`, `btc_dominance` |
| `market_news` | News sentiment feed | `title`, `source`, `sentiment`, `sentiment_score` |
| `order_book_snapshots` | L2/L3 order book | `bids`, `asks`, `spread`, `depth` columns |
| `slippage_history` | Transaction cost log | `predicted_slippage`, `realized_slippage`, `regime` |
| `toxicity_metrics` | Microstructure signals | `vpin`, `order_imbalance`, `spread_volatility` |
| `audit_*` (6 tables) | Regulatory audit trail | Trade, balance, user action, system event + archives |
| `paper_*` (4 tables) | Paper trading state | Positions, orders, summary, audit log |
| `optimization_trials` | Bayesian optimization | Hyperparameter tuning results |
| `order_reconciliation_log` | Exchange reconciliation | Sync status tracking |

### Index Coverage

- `idx_candles_symbol_timeframe_time` — range queries on candle data
- `idx_shadow_trades_risk_mode_status` — filtering trades by mode/status
- `idx_regime_history_timestamp` — chronological regime changes
- `idx_slippage_history_symbol_timestamp` — cost analysis by time
- `idx_order_book_snapshots_symbol_timestamp` — depth analysis
- `idx_paper_positions_symbol_status` — open position management
- `idx_paper_orders_status` — order lifecycle tracking

---

## 3. Known Issues & Workarounds

### Issue 1: Shadow Trades Empty After Seed (ROOT CAUSE IDENTIFIED)
- **Symptom**: `shadow_trades` table shows 0 rows after `seedDatabase()` runs
- **Root Cause**: Seed skip condition used `AND` logic — candles existed from prior run while shadow_trades was empty, so seed "skipped"
- **Fix**: Changed to `OR` logic: skip only if either table already has data
- **Status**: ✅ Fixed in `seed.ts`

### Issue 2: Seed Only Covers 5 of 6 Risk Modes
- **Missing**: `ai_enhanced` mode not included in seed data
- **Impact**: Performance dashboard shows empty data for AI-enhanced mode until first live cycle
- **Workaround**: Manually insert seed trades for `ai_enhanced` or run a full trading cycle
- **Status**: ⚠️ Low priority — cosmetic/demo issue

### Issue 3: Database Initialization Gap
- **Symptom**: `initDatabase()` in `database.ts` did not create tables for SQLite mode
- **Original Code**: Table creation was only in `database_worker.ts` (worker thread context)
- **Fix**: Added full schema creation (`CREATE TABLE IF NOT EXISTS` for 25+ tables) to `database.ts` `initDatabase()`
- **Status**: ✅ Fixed in `backend/database.ts`

### Issue 4: Async Performance Broadcast Crash
- **Symptom**: `this.shadowTrader.getPerformance()` called without `await` in `start()`, causing unhandled promise rejection when tables missing
- **Fix**: Changed to `.then().catch()` with fallback broadcast of empty object
- **Status**: ✅ Fixed in `backend/main.ts`

### Issue 5: Redis Unavailability Crashes Server
- **Symptom**: Server fails to start if Redis is not running (default port 6380 in `.env`)
- **Fix**: Added graceful Redis fallback — uses in-memory session store if Redis unavailable
- **Status**: ✅ Fixed in `server.ts`

### Issue 6: OpenTelemetry DNS Resolution Failure
- **Symptom**: `http://tempo:4317` unresolvable in non-Docker environments
- **Fix**: Changed default OTLP endpoint to `http://localhost:4317` with try-catch on SDK start
- **Status**: ✅ Fixed in `server.ts`

---

## 4. Seed Data Characteristics

### Trade Data Distribution
- **Symbols**: BTC/USDT, ETH/USDT, SOL/USDT (randomized per trade)
- **Sides**: buy/sell (randomized)
- **Prices**: $60,000–$65,000 ± random offset
- **Amounts**: 0.01–0.51 units
- **PnL**: Winners: +$10–$60 | Losers: -$5–$35
- **Timestamps**: Spaced 1 hour apart, spanning ~10 hours

### Candle Data Characteristics
- **Timeframe**: 1-minute
- **Price Movement**: Random walk starting at $50,000 ± $50 per candle
- **Coverage**: ~8.3 hours of BTC/USDT data per symbol (500 candles)
- **Volume**: Randomized 0–100

### Data Integrity Notes
- Shadow trades use mock IDs: `mock-{mode}-closed-{i}`, `mock-{mode}-open-{i}`
- No duplicate detection beyond primary key constraint
- Seed data is **completely independent** of actual market data — no correlation

---

## 5. Database Files & Cleanup

### File Locations
```
project/
├── trading.db                    # Active SQLite database
├── trading.db-wal                # Write-Ahead Log (WAL mode)
├── trading.db-shm                # Shared memory file
├── backups/
│   └── trading.db.{timestamp}.db  # Automatic daily + startup backups
└── seed.ts                       # Database seeding logic
```

### Safe Cleanup Commands
```bash
# Clean database (keeps backups)
rm -f trading.db trading.db-wal trading.db-shm

# Clean all including backups
rm -f trading.db* backups/*.db

# Note: Backups are recreated on each server start
```

---

## 6. Migration Notes: SQLite vs PostgreSQL

| Feature | SQLite (Default) | PostgreSQL (USE_POSTGRES=true) |
|---|---|---|
| Schema creation | Automatic on init | Via `initPostgresDatabase()` |
| Concurrent writes | Limited (WAL mode) | Full |
| Production ready | No (memory store fallback) | Yes |
| Index optimization | Basic | Advanced with partial indexes |
| Recommended for | Development/testing | Production/staging |

---

## 7. Relevant Code Paths

```
server.ts:startServer()
  ├── initDatabase()           # backend/database.ts:8-44
  │   ├── createTables()       # Added — CREATE TABLE IF NOT EXISTS × 25+
  │   └── setupMockRunQuery()  # SQLite direct access function
  │
  ├── seedDatabase()           # seed.ts:3-77
  │   ├── checkTableCounts()   # Skip if any data exists
  │   ├── insertShadowTrades() # 60 records across 5 modes
  │   └── insertCandles()      # 1500 records across 3 symbols
  │
  └── startTradingEngine()     # backend/main.ts:1012-1017
      ├── TradingEngine.init()  # Calls loadSettings()
      ├── shadowTrader.reset() # Sets balances to $100,000
      └── getPerformance()      # Async — now .then().catch() safe
```

---

*This document was auto-generated during system stabilization. Review and update when seed logic changes.*