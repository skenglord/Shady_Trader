# AI Shadow Trading System Documentation

## Overview
This system is an AI-augmented algorithmic trading platform that supports multiple risk modes running in parallel (Shadow Trading). It uses Gemini AI for regime detection, sentiment analysis, and signal confirmation.

## API Integrations

The system integrates with two types of external APIs: **Exchange APIs** (for live trading and fallback market data) and **Market Data APIs** (for primary chart data and sentiment).

### Exchange APIs
These APIs are used to execute live trades when a shadow trade is triggered in the active mode. They can also be used as a fallback for fetching OHLCV (candlestick) data.

1. **Binance**
   - **Required Fields**: `API Key`, `API Secret`
   - **Notes**: Supports Testnet. Ensure your API key has Spot Trading enabled.

2. **Bybit**
   - **Required Fields**: `API Key`, `API Secret`
   - **Notes**: Supports Testnet. Ensure your API key has Spot Trading enabled.

3. **OKX**
   - **Required Fields**: `API Key`, `API Secret`, `API Password` (Passphrase)
   - **Notes**: OKX requires a third credential (the passphrase you set when creating the API key). Supports Testnet.

4. **Kraken**
   - **Required Fields**: `API Key`, `API Secret`
   - **Notes**: Does not have a standard Testnet for spot trading via ccxt in the same way as Binance/Bybit.

5. **Coinbase (Advanced Trade)**
   - **Required Fields**: `API Key`, `API Secret`, `API Password` (Passphrase - required for some older Pro keys, but new Advanced Trade keys might just need Key/Secret. If using Legacy Pro, provide the passphrase).
   - **Notes**: Ensure you are using the new Advanced Trade API keys.

### Market Data APIs
These APIs are used to fetch historical and live candlestick data for the charts and indicators.

1. **CoinGecko**
   - **Required Fields**: `API Key` (Optional)
   - **Notes**: The public API does not require a key but is heavily rate-limited. If you have a CoinGecko Pro account, enter your API key to use the `x-cg-pro-api-key` header and the pro endpoint. Note: CoinGecko's OHLC endpoint does not provide volume data, so volume is mocked.

2. **CoinMarketCap**
   - **Required Fields**: `API Key`
   - **Notes**: Requires a paid plan for historical OHLCV data. The basic tier does not support it.

3. **CryptoCompare**
   - **Required Fields**: `API Key`
   - **Notes**: Provides excellent historical OHLCV data. The free tier is usually sufficient for standard timeframes.

4. **Glassnode**
   - **Required Fields**: `API Key`
   - **Notes**: Primarily used for on-chain metrics rather than standard OHLCV.

5. **Messari**
   - **Required Fields**: `API Key`
   - **Notes**: Uses the `x-messari-api-key` header. Good for fundamental data and sentiment.

## Trading Strategies

### 1. Regime Based (Default)
Uses technical indicators (EMA, RSI, Bollinger Bands) and AI confirmation to trade based on the detected market regime (Strong Bull, Weak Bull, Bear, Sideways).

### 2. Shotgun
Initiates a buy or sell order 0.5 seconds before the end of every candle and closes the order 10 seconds after.
- **Configurable**: Time before candle end, time after candle end.

### 3. Alt Chaser
Initiates buy or sell orders whenever Bitcoin's price increases or decreases by more than 1% over the time period of one single candle.
- **Configurable**: Percentage change threshold.

### 4. Chasing Dragons
After initiating a trade, if the probability score leaving the candle is the same or better than it was at the beginning of the candle, leverage is added to the order.
- **Default**: 7x leverage, 6% stop loss.
- **Configurable**: Leverage amount, stop loss percentage.

## Configuration
To configure these APIs and strategies:
1. Open the Settings modal (gear icon) in the UI.
2. Select your Primary Exchange and Market Data API.
3. Select your Trading Strategy and configure its parameters.
4. Enter the required keys.
5. Alternatively, you can set `EXCHANGE_API_KEY` and `EXCHANGE_API_SECRET` in your `.env` file for the default exchange.

## Testing
Run `npm run test` to execute the system tests, which cover the Regime Detector, Signal Generator, Risk Manager, and Shadow Trader logic.
