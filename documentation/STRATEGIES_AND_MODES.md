# Strategies and Modes: Technical Specification

This document outlines the granular logic governing trade initiation, risk management, and execution across all modes and strategies in the system.

## 1. Risk Modes

The system maintains 6 "Shadow Portfolios", each with its own risk parameters.

| Mode | Max Risk/Trade | Max Drawdown | Max Positions | Leverage | Return funds to... |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Ultra Conservative** | 0.5% | 5% | 1 | 1x | Bot Balance |
| **Conservative** | 1.0% | 8% | 2 | 2x | Bot Balance |
| **Moderate** | 2.0% | 12% | 3 | 5x | Bot Balance |
| **Aggressive** | 5.0% | 18% | 5 | 20x | Bot Balance |
| **Degen** | 10.0% | 30% | 10 | 100x | Bot Balance |
| **AI Enhanced** | 2.0% | 12% | 3 | 5x | Bot Balance |

> **Note**: Users can toggle "Return funds to Main Balance" per mode to harvest profits or protect capital.

---

## 2. Trading Strategies

### A. Regime-Based (Standard)
Dynamically adapts based on the detected market regime (`RegimeDetector`).
- **Strong Bull**: Buys dips when price bounces off EMA 21 and RSI > 50.
- **Weak Bull**: Mean reversion buys near lower Bollinger Band when RSI is oversold (< 40).
- **Bear**: Shorts rallies at upper Bollinger Band when RSI is overbought (> 60).
- **Sideways**: Range-bound trading; buys support (Lower BB), sells resistance (Upper BB).

### B. Shotgun (High Frequency)
Designed for capturing quick momentum bursts.
- **Trigger**: Price change > 0.2% in one candle AND Volume Ratio > 1.5 AND RSI > 60 (Buy) or < 40 (Sell).
- **Targets**: Very tight TP/SL (0.5% each) for rapid turnover.

### C. Chasing Dragons (Trend Following)
Aggressive trend following using EMA alignment.
- **Buy Trigger**: EMA 9 > EMA 21 > EMA 50 AND Price > EMA 9 AND RSI > 55.
- **Sell Trigger**: EMA 9 < EMA 21 < EMA 50 AND Price < EMA 9 AND RSI < 45.
- **Stop Loss**: Dynamic stop at the EMA 21 line.

### D. Alt Chaser (Volatility Scalp)
Captures sudden shifts in price action.
- **Trigger**: Price change > 1% relative to the previous candle.
- **Targets**: Standard 2% TP / 2% SL.

---

## 3. Core Indicators

The system calculates indicators using a 50-candle warmup period:
- **EMAs (9, 21, 50)**: Used for trend direction and dynamic support/resistance.
- **RSI (14)**: Identifies overbought/oversold conditions and confirms momentum.
- **Bollinger Bands (20, 2.0)**: Measures volatility and defines range boundaries.
- **ADX (14)**: Measures trend strength (min 30 for Strong Bull).
- **VWAP**: Benchmark for average price based on volume.
- **Volume Ratio**: Current volume vs. 20-period SMA to detect spikes.

---

## 4. Execution Logic

### Entry
1. **Signal Generation**: Technical indicators meet strategy criteria.
2. **AI Confirmation (Optional)**: Gemini analyzes context (20 candles + news + stats). If "confirmed" is false, entry is aborted.
3. **Risk Check**: Validates if `maxConcurrentPositions` or `maxDrawdown` has been reached.
4. **Sizing**: Position size calculated based on `maxRiskPerTrade` vs. Distance to Stop Loss.

### Exit
1. **Take Profit / Stop Loss**: Constantly monitored every cycle.
2. **Trailing Stop**: For Buy trades, if profit > 1%, the Stop Loss trails at 1% below current price.
3. **Liquidation**: Monitored based on leverage and a 0.5% maintenance margin.
4. **Kill Bot**: Manual override that closes all positions and returns funds to Main Balance.
