# pragma: no cover
"""
ShadyTraderReferenceStrategy — VALIDATION ONLY (NOT FOR LIVE TRADING)
=====================================================================

Purpose
-------
This Freqtrade IStrategy mirrors the in-house TypeScript indicator→regime→signal
pipeline as closely as possible.  Its **sole** purpose is to produce a backtest
trade ledger that can be cross-validated against the in-house backtester
(backend/scripts/backtest.ts + backend/main.ts).  DO NOT use this strategy for
live or paper trading.

Translation notes
-----------------
- The in-house pipeline uses `technicalindicators` (JS).  This strategy uses
  `pandas_ta` for the same indicators.
- Risk-mode-specific parameters (stoploss, minimal_roi, trailing_stop) are
  selected at import time based on the exported variable ``TRADING_MODE``,
  matching the ``DEFAULT_RISK_CONFIGS`` dictionary in the TS engine.
- The strategy sets ``startup_candle_count = 200`` to cover the longest
  indicator lookback (EMA-200).

Accepted deltas (between in-house and Freqtrade backtest results)
------------------------------------------------------------------
- Sharpe ratio:        ±5 %
- Max drawdown:       ±10 %
- Trade count:        ±1 trade   (30-day window)

These tolerances are encoded in the CI step (see :: ci.yml) and the
``/api/freqtrade/validate`` endpoint (see ``FREQTRADE_VALIDATE_TOLERANCE`` env var).

Indicator reference
-------------------
+-------------------+-------------------+------------------+---------------------------+
| Indicator         | pandas_ta call    | Period / default | In-house equivalent       |
+-------------------+-------------------+------------------+---------------------------+
| EMA-50            | ta.ema(close, 50) | 50               | `ema(close, 50)`          |
| EMA-200           | ta.ema(close,200) | 200              | `ema(close, 200)`         |
| RSI-14            | ta.rsi(close, 14) | 14               | `rsi(close, 14)`          |
| MACD              | ta.macd(close)    | 12-26-9          | `macd(close)`             |
| Bollinger Bands   | ta.bbands(close)  | 20-2             | `bollinger(close, 20, 2)` |
| ATR-14            | ta.atr(high,low,close,14) | 14        | `atr(high, low, close,14)`|
+-------------------+-------------------+------------------+---------------------------+

Position sizing and entry/exit logic
-------------------------------------
This is a bare-bones momentum strategy used only for cross-validation, NOT for
actual trading.  The in-house pipeline applies regime detection and multiple
risk modes; this strategy uses a single default risk mode so the trade signals
are deterministic and comparable.
"""

from typing import Any, Dict

import pandas as pd
import pandas_ta as ta  # noqa: F401 — needed for DataFrame.ta accessor

from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter


# ---------------------------------------------------------------------------
# Risk-mode config matching DEFAULT_RISK_CONFIGS[mode] for "conservative"
# ---------------------------------------------------------------------------
TRADING_MODE: str = "conservative"

# These values mirror backend/risk/config.ts → DEFAULT_RISK_CONFIGS.
_RISK_PARAMS: Dict[str, Dict[str, Any]] = {
    "conservative": {
        "stoploss": -0.05,
        "trailing_stop": True,
        "trailing_stop_positive": 0.01,
        "trailing_stop_positive_offset": 0.02,
        "trailing_only_offset_is_reached": True,
        "minimal_roi": {"0": 0.08, "30": 0.04, "60": 0.02, "120": 0},
        "min_trade_size_usdt": 50,
    },
    "moderate": {
        "stoploss": -0.08,
        "trailing_stop": True,
        "trailing_stop_positive": 0.02,
        "trailing_stop_positive_offset": 0.03,
        "trailing_only_offset_is_reached": True,
        "minimal_roi": {"0": 0.12, "30": 0.06, "60": 0.03, "120": 0},
        "min_trade_size_usdt": 50,
    },
    "aggressive": {
        "stoploss": -0.12,
        "trailing_stop": True,
        "trailing_stop_positive": 0.03,
        "trailing_stop_positive_offset": 0.04,
        "trailing_only_offset_is_reached": True,
        "minimal_roi": {"0": 0.20, "30": 0.10, "60": 0.05, "120": 0},
        "min_trade_size_usdt": 50,
    },
}

# Select parameters for the configured trading mode.
_current_params = _RISK_PARAMS.get(TRADING_MODE, _RISK_PARAMS["conservative"])


class ShadyTraderReferenceStrategy(IStrategy):
    """
    Validation-only reference strategy.  Do NOT use for live trading.
    """

    INTERFACE_VERSION = 3

    # --- Timeframe ---
    timeframe = "1h"

    # --- Can short (futures) ---
    can_short = True

    # --- Risk parameters (from TRADING_MODE) ---
    stoploss = _current_params["stoploss"]
    trailing_stop = _current_params["trailing_stop"]
    trailing_stop_positive = _current_params["trailing_stop_positive"]
    trailing_stop_positive_offset = _current_params["trailing_stop_positive_offset"]
    trailing_only_offset_is_reached = _current_params["trailing_only_offset_is_reached"]
    minimal_roi = _current_params["minimal_roi"]

    # --- Startup candles (must cover EMA-200 lookback) ---
    startup_candle_count: int = 200

    # --- Optional params exposed for hyperopt (future) ---
    buy_rsi = IntParameter(25, 40, default=30, space="buy")
    sell_rsi = IntParameter(60, 80, default=70, space="sell")
    atr_mult = DecimalParameter(1.0, 4.0, default=2.0, decimals=1, space="sell")

    # ─────────────────────────────────────────────────────────────────
    #  populate_indicators
    # ─────────────────────────────────────────────────────────────────
    def populate_indicators(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        """
        Compute indicators matching the in-house pipeline.

        Note: pandas_ta indicators are appended as new columns to the
        DataFrame.  See the docstring above for the mapping table.
        """
        # EMAs
        dataframe["ema50"] = ta.ema(dataframe["close"], length=50)
        dataframe["ema200"] = ta.ema(dataframe["close"], length=200)

        # RSI
        dataframe["rsi"] = ta.rsi(dataframe["close"], length=14)

        # MACD (default 12-26-9)
        macd = ta.macd(dataframe["close"])
        if macd is not None:
            dataframe["macd"] = macd["MACD_12_26_9"]
            dataframe["macd_signal"] = macd["MACDs_12_26_9"]
            dataframe["macd_hist"] = macd["MACDh_12_26_9"]

        # Bollinger Bands (20-period, 2 std)
        bbands = ta.bbands(dataframe["close"], length=20, std=2)
        if bbands is not None:
            dataframe["bb_upper"] = bbands["BBU_20_2.0"]
            dataframe["bb_middle"] = bbands["BBM_20_2.0"]
            dataframe["bb_lower"] = bbands["BBL_20_2.0"]
            dataframe["bb_width"] = bbands["BBB_20_2.0"]  # bandwidth
            dataframe["bb_percent"] = bbands["BBP_20_2.0"]  # %B

        # ATR (14-period)
        atr_df = ta.atr(
            high=dataframe["high"],
            low=dataframe["low"],
            close=dataframe["close"],
            length=14,
        )
        if atr_df is not None:
            dataframe["atr"] = atr_df  # already a Series named "ATR_14"

        # Cleanup: drop NaN rows that don't have full indicator history
        # (Freqtrade handles this internally via startup_candle_count)
        return dataframe

    # ─────────────────────────────────────────────────────────────────
    #  populate_entry_trend
    # ─────────────────────────────────────────────────────────────────
    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        """
        Entry signals — momentum crossover with confirmation.

        Conditions (all must be true):
        1. Price > EMA-200  (uptrend)
        2. EMA-50 > EMA-200 (golden cross — trend confirmation)
        3. RSI < buy_rsi    (oversold entry)
        4. MACD histogram > 0 (momentum positive)
        5. Bollinger band squeeze: close < bb_middle (buying dip)
        6. Volume > 0       (non-stale candle)
        """
        dataframe.loc[
            (
                (dataframe["close"] > dataframe["ema200"])
                & (dataframe["ema50"] > dataframe["ema200"])
                & (dataframe["rsi"] < self.buy_rsi.value)
                & (dataframe["macd_hist"] > 0)
                & (dataframe["close"] < dataframe["bb_middle"])
                & (dataframe["volume"] > 0)
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "enter_long_reference")

        # Short conditions (bearish mirror)
        dataframe.loc[
            (
                (dataframe["close"] < dataframe["ema200"])
                & (dataframe["ema50"] < dataframe["ema200"])
                & (dataframe["rsi"] > self.sell_rsi.value)
                & (dataframe["macd_hist"] < 0)
                & (dataframe["close"] > dataframe["bb_middle"])
                & (dataframe["volume"] > 0)
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "enter_short_reference")

        return dataframe

    # ─────────────────────────────────────────────────────────────────
    #  populate_exit_trend
    # ─────────────────────────────────────────────────────────────────
    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        """
        Exit signals — momentum exhaustion.

        Long exit (any of):
        - RSI > sell_rsi   (overbought)
        - Price closes above bb_upper (bollinger band touch)
        - MACD histogram < 0 (momentum flipping)

        Short exit (any of):
        - RSI < buy_rsi    (oversold bounce)
        - Price closes below bb_lower
        - MACD histogram > 0
        """
        # Long exits
        dataframe.loc[
            (
                (dataframe["rsi"] > self.sell_rsi.value)
                | (dataframe["close"] > dataframe["bb_upper"])
                | (dataframe["macd_hist"] < 0)
            )
            & (dataframe["volume"] > 0),
            ["exit_long", "exit_tag"],
        ] = (1, "exit_long_reference")

        # Short exits
        dataframe.loc[
            (
                (dataframe["rsi"] < self.buy_rsi.value)
                | (dataframe["close"] < dataframe["bb_lower"])
                | (dataframe["macd_hist"] > 0)
            )
            & (dataframe["volume"] > 0),
            ["exit_short", "exit_tag"],
        ] = (1, "exit_short_reference")

        return dataframe
