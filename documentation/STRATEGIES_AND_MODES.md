# Strategies and Modes: Technical Specification

This document outlines the granular logic governing trade initiation, risk management, and execution across all modes and strategies in the system.

## 1. Risk Modes

The system maintains 6 "Shadow Portfolios", each with its own risk parameters.

| Mode | Pos Size | Max Drawdown | Max Positions | Leverage | Active Regimes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Ultra Conservative** | 2% | 7% | 1 | 1x | Strong/Weak Bull |
| **Conservative** | 3% | 11% | 2 | 1x | Bull/Sideways |
| **Moderate** | 5% | 15% | 3 | 1.5x | Bull/Sideways |
| **Aggressive** | 8% | 22% | 4 | 2x | All Regimes |
| **Degen** | 15% | 35% | 5 | 3x | All Regimes |
| **AI Enhanced** | 5% | 15% | 3 | 1.5x | Bull/Sideways (Mandatory AI) |

> **Note**: Users can toggle "Return funds to Main Balance" per mode to harvest profits or protect capital.

---

## 2. Trading Strategies

### A. Regime-Based (Standard) - Weighted Scoring
Dynamically adapts using a weighted indicator confluence system.
- **Strong Bull**: Trend following. Weights: EMA Trend (45%), RSI Momentum (20%), Volume Surge (20%), Stoch RSI (15%). Score >= 60 to enter.
- **Weak Bull**: Hybrid approach. Weights: Mean Reversion (60%) or Momentum Breakout (40%) + Volume confirmation (15%). 30% penalty if price < VWAP.
- **Bear**: Shorting rallies. Weights: EMA Downtrend (30%), Resistance Rejection (50%), MACD Confirmation (15%). *Restricted to Aggressive/Degen modes.*
- **Sideways**: Range extremes. Weights: Bollinger Bands (30%), RSI (25%), Stoch (20%). Penalized if volume is spiking.

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
1. **Weighted Signal Scoring**: Sums indicators based on regime weights. Minimum score required for entry.
2. **AI Validation Layer**: (Optional/Toggleable) Gemini validates regime classification and signal context using news and shadow performance.
3. **Regime Enforcement**: Modes like Ultra-Conservative stay in cash during Bear/Sideways markets.
4. **Dynamic Sizing**: Position size = `baseSize * confidenceMultiplier (0.7 to 1.2)`.

### Exit & Trade Management
1. **Multi-Candle Holds**: (Moderate+) Trades can extend across candles if in profit > 0.5% and trend holds.
2. **Trailing Stop**: Dynamic 0.4% trail behind the highest price achieved (starts after 0.5% profit).
3. **Runner Positions**: (Aggressive+) At 1.5% profit, 60% of position is closed; remaining 40% runs with wider trailing stops.
4. **Early Exit**: (Conservative+) Exit immediately if fixed target (e.g., 0.8%) is hit before candle close.
5. **Circuit Breakers**: Halts trading on max drawdown, max daily loss (3-15%), consecutive losses (>= 5), or 3x volatility spikes.
