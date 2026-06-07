# Freqtrade Strategy Translation Matrix

> **Status:** DRAFT — v6.0 integration  
> **Author:** Subagent 1 (Bootstrap + Reference Strategy)  
> **Last updated:** 4 June 2026

## Purpose

This document maps Shady_Trader's in-house (TypeScript) indicator→regime→signal
pipeline onto the `ShadyTraderReferenceStrategy` Python `IStrategy` class used
by Freqtrade for cross-validation backtesting.

## 1. Risk Mode Mapping

The in-house engine selects parameters from `DEFAULT_RISK_CONFIGS[mode]` in
`backend/risk/config.ts`. The reference strategy embeds the same three modes:

| In-house `RiskMode` | Reference strategy params | `stoploss` | `trailing_stop_positive` | `minimal_roi` (0 min) |
|---|---|---|---|---|
| `conservative` | `_RISK_PARAMS["conservative"]` | -5% | 1% | 8% |
| `moderate` | `_RISK_PARAMS["moderate"]` | -8% | 2% | 12% |
| `aggressive` | `_RISK_PARAMS["aggressive"]` | -12% | 3% | 20% |

The active mode is selected via the module-level `TRADING_MODE` variable
(default: `"conservative"`). During validation the bridge should set this to
match the in-house run's risk mode.

## 2. Indicator Translation

| In-house (TypeScript — `technicalindicators`) | Freqtrade (Python — `pandas_ta`) | Period | Notes |
|---|---|---|---|
| `ema(close, 50)` | `ta.ema(dataframe["close"], length=50)` | 50 | Column name: `ema50` |
| `ema(close, 200)` | `ta.ema(dataframe["close"], length=200)` | 200 | Column name: `ema200` |
| `rsi(close, 14)` | `ta.rsi(dataframe["close"], length=14)` | 14 | Column name: `rsi` |
| `macd(close)` | `ta.macd(dataframe["close"])` | 12-26-9 | 3 columns: `macd`, `macd_signal`, `macd_hist` |
| `bollinger(close, 20, 2)` | `ta.bbands(dataframe["close"], length=20, std=2)` | 20-2 | 5 columns: `bb_upper`, `bb_middle`, `bb_lower`, `bb_width`, `bb_percent` |
| `atr(high, low, close, 14)` | `ta.atr(high, low, close, length=14)` | 14 | Column name: `atr` |

## 3. Entry Signal Logic

### Long entry (all conditions must be true)

| # | Condition | Reference |
|---|---|---|
| 1 | `close > ema200` | Uptrend filter |
| 2 | `ema50 > ema200` | Golden cross confirmation |
| 3 | `rsi < buy_rsi` (default 30) | Oversold entry |
| 4 | `macd_hist > 0` | Positive momentum |
| 5 | `close < bb_middle` | Buying the dip |
| 6 | `volume > 0` | Non-stale candle |

Entry tag: `enter_long_reference`

### Short entry (all conditions must be true)

| # | Condition | Reference |
|---|---|---|
| 1 | `close < ema200` | Downtrend filter |
| 2 | `ema50 < ema200` | Death cross confirmation |
| 3 | `rsi > sell_rsi` (default 70) | Overbought entry |
| 4 | `macd_hist < 0` | Negative momentum |
| 5 | `close > bb_middle` | Selling the top |
| 6 | `volume > 0` | Non-stale candle |

Entry tag: `enter_short_reference`

## 4. Exit Signal Logic

### Long exit (any one condition triggers)

| # | Condition | Rationale |
|---|---|---|
| 1 | `rsi > sell_rsi` (default 70) | Overbought — exhaustion |
| 2 | `close > bb_upper` | Bollinger band touch |
| 3 | `macd_hist < 0` | Momentum flipping negative |

Exit tag: `exit_long_reference`

### Short exit (any one condition triggers)

| # | Condition | Rationale |
|---|---|---|
| 1 | `rsi < buy_rsi` (default 30) | Oversold — bounce |
| 2 | `close < bb_lower` | Bollinger band touch |
| 3 | `macd_hist > 0` | Momentum flipping positive |

Exit tag: `exit_short_reference`

## 5. Parametrisation Differences

| Concern | In-house | Freqtrade Reference | Rationale |
|---|---|---|---|
| Position sizing | `positionSize = wallet * riskPerTrade / atr` | Fixed `stake_amount: "unlimited"` with `max_open_trades: 3` | Freqtrade simulates position sizing internally; keep simple for validation |
| Slippage | `computeBacktestMetrics` applies a flat 0.1% per side | Freqtrade uses `entry_pricing` / `exit_pricing` config with order-book simulation | Different models; validate at metric level, not per-trade |
| Fee model | `0.1%` flat (binance spot) | `"fee": 0.001` in config.json | Matched explicitly in validation run |
| Leverage | Configurable via `positionMode` | Futures mode: `"trading_mode": "futures"` with `"margin_mode": "isolated"` | Both default to 1× for validation |

## 6. Validation Protocol

```
In-house backtest                  Freqtrade backtest
         │                                │
         ▼                                ▼
  computeBacktestMetrics()    freqtrade backtesting --export trades
         │                                │
         └──────────┬─────────────────────┘
                    ▼
            Reconciliation
      ┌─────────────────────────┐
      │ Sharpe Δ < 5%           │
      │ MDD    Δ < 10%          │
      │ TradeCount Δ ≤ 1        │
      └─────────────────────────┘
```

The reconciliation is performed by `/api/freqtrade/validate` (Phase 4) or the
CI step in `.github/workflows/ci.yml` (Phase 7).

## 7. File Locations

| Artifact | Path |
|---|---|
| Reference strategy | `backend/freqtrade/user_data/strategies/ShadyTraderReferenceStrategy.py` |
| In-house backtest | `backend/scripts/backtest.ts` |
| Risk mode config | `backend/risk/config.ts` |
| Validation API | `/api/freqtrade/validate` (Phase 4) |
| Integration plan | `documentation/upgrades/freqtrade_integration_plan.md` |

---

*End of translation matrix. See `freqtrade_integration_plan.md` §6 Phase 1 for
the original requirements.*
