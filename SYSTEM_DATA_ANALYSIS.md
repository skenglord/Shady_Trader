# System Data Analysis - Why No Data is Being Processed

## Executive Summary

The system has stale data from May 12, 2026 (~3 days old) because the configured exchange (CoinMarketCap) requires an API key that is not set. Without an API key, the exchange connector is "disabled" and does not fetch live price data, which means no new candles are being written to the database.

---

## Data Flow Architecture

### How Data Flows Through the System

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA FLOW DIAGRAM                                 │
└─────────────────────────────────────────────────────────────────────────────┘

  EXTERNAL APIs                          BACKEND                              DATABASE
  ────────────                           ───────                              ────────

  ┌─────────────────┐                   ┌──────────────────────┐
  │ CoinMarketCap   │                   │ MarketDataService   │
  │ (requires key)  │──── prices ──────▶│ fetches:            │
  └─────────────────┘                   │ - market_cap        │
                                         │ - volume            │
  ┌─────────────────┐                   │ - fear/greed index  │────────┐
  │ CoinGecko       │──── OHLCV ────────▶│ - BTC dominance     │        │
  │ (free tier)     │                   │ - news              │        ▼
  └─────────────────┘                   └──────────────────────┘   ┌────────┐
                                         ┌──────────────────────┐   │market_ │
  ┌─────────────────┐                   │  ExchangeConnector  │   │data DB │
  │ Binance        │──── price ────────▶│                      │   │table   │
  │ (public API)   │      ticks         │ fetches every 5s:  │   └────────┘
  └─────────────────┘                   │ - live prices       │          │
                                         │ - writes to:        │   ┌────────┐
  ┌─────────────────┐                   │   candles table     │   │candles │
  │ Kraken/OKX/    │                   └──────────────────────┘   │table   │
  │ Coinbase       │                                              └────────┘
  └─────────────────┘                            │                          │
                                                 ▼                          ▼
                                        ┌──────────────────────┐    ┌──────────┐
                                        │   TradingEngine      │    │ FRONTEND │
                                        │   runCycle()         │    │          │
                                        │ - regime detection  │    │ /api/    │
                                        │ - signal generation  │    │ candles  │
                                        │ - execution          │    │          │
                                        └──────────────────────┘    └──────────┘
                                              │                         │
                                              ▼                         ▼
                                        ┌──────────────────────┐    ┌──────────┐
                                        │ ShadowTrader         │    │ Charts   │
                                        │ (6 risk modes)       │    │ Display  │
                                        └──────────────────────┘    └──────────┘

```

### Key Components

| Component | Purpose | Data Source |
|-----------|---------|--------------|
| `MarketDataService` | Global market metrics | CoinGecko API (free), alternative.me |
| `ExchangeConnector` | Price data + candles | Configured exchange |
| `candles` DB table | OHLCV historical data | ExchangeConnector.write() |
| `market_data` DB table | Global metrics | MarketDataService.write() |
| `/api/candles` endpoint | Serves data to frontend | Reads from DB |

---

## Root Cause Analysis

### Problem: No New Data Being Processed

**Symptom**: Charts show stale data from May 12, 2026.

**Root Cause**: The configured exchange is `coinmarketcap` which requires an API key to fetch price data. Without the key, the exchange is "disabled" - no live prices are fetched, and no new candles are written.

### Evidence from Logs

```
[TradingEngine] Exchange "coinmarketcap" requires EXCHANGE_API_KEY or persisted settings.apiKey. Exchange disabled until configured.
```

### Code Evidence

In `backend/exchange/connector.ts` lines 236-252, CoinMarketCap requires an API key:

```typescript
// CoinMarketCap requires API key - won't execute without it
const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
  headers: {
    'X-CMC_PRO_API_KEY': this.apiKey,  // <-- Required!
    Accept: 'application/json'
  },
  // ...
});
```

---

## Current Database State

```bash
$ sqlite3 trading.db "SELECT symbol, timeframe, COUNT(*), MIN(time), MAX(time) FROM candles GROUP BY symbol, timeframe;"

BTC/USDT|1m|500|1778519195242|1778549135242  # From May 12, 2026
ETH/USDT|1m|500|1778519195242|1778549135242
SOL/USDT|1m|500|1778519195242|1778549135242
```

The timestamps show data from May 12 - the exchange stopped fetching on that date.

---

## Solution Options

### Option 1: Use Binance (RECOMMENDED - Free, No API Key Required)

Binance provides free public API access without requiring an API key for market data.

**Steps:**

1. Edit `.env`:
```bash
EXCHANGE_NAME=binance
EXCHANGE_USE_TESTNET=true  # or false for production
```

2. Or use the UI Settings to change exchange

3. Restart the server:
```bash
# Stop current server, then:
npm run dev
```

**Why this works:**
- Binance public API doesn't require authentication for price data
- The connector.ts (lines 172-185) handles this correctly
- Data will start flowing immediately

---

### Option 2: Use CoinGecko (Free, Limited)

CoinGecko provides free tier but with rate limits.

**Steps:**

1. Get a free API key from https://www.coingecko.com/en/api
2. Edit `.env`:
```bash
COINGECKO_API_KEY=your_free_api_key
```

3. Or use the existing fallback - the system already tries CoinGecko for historical data

---

### Option 3: Use CoinMarketCap Pro (Paid)

Get a paid CoinMarketCap API key for full access.

**Steps:**

1. Sign up at https://pro.coinmarketcap.com/
2. Get your API key
3. Edit `.env`:
```bash
EXCHANGE_NAME=coinmarketcap
EXCHANGE_API_KEY=your_api_key_here
```

**Note:** The free tier has limited historical data access.

---

### Option 4: Use Other Exchanges (Requires API Keys)

The system also supports: Kraken, OKX, Coinbase. Each requires API keys for authentication.

```bash
# Kraken - requires API key
EXCHANGE_NAME=kraken
EXCHANGE_API_KEY=your_key
EXCHANGE_API_SECRET=your_secret

# OKX - requires API key + password
EXCHANGE_NAME=okx
EXCHANGE_API_KEY=your_key
EXCHANGE_API_SECRET=your_secret
EXCHANGE_API_PASSWORD=your_password

# Coinbase - requires API key
EXCHANGE_NAME=coinbase
EXCHANGE_API_KEY=your_key
EXCHANGE_API_SECRET=your_secret
```

---

## Configuration Instructions

### Step-by-Step: Enable Binance (Recommended)

**Method 1: Via .env file**

```bash
# Edit .env in project root
nano .env
```

Find and change:
```
EXCHANGE_NAME=coinmarketcap
```
to:
```
EXCHANGE_NAME=binance
```

Save and restart the server.

**Method 2: Via Web UI**

1. Open http://localhost:3000
2. Navigate to Settings
3. Find "Exchange" dropdown
4. Select "Binance"
5. Save

**Verify data is flowing:**

```bash
# Check logs for successful price fetches
tail -f logs/app.log | grep -E "price|Prices"

# Or check database for new data
sqlite3 trading.db "SELECT time, close FROM candles WHERE symbol='BTC/USDT' ORDER BY time DESC LIMIT 1;"
# Should show recent timestamp (within last minute)
```

---

## Complete API Key Reference

| Service | Key Name | Where to Get | Cost |
|---------|----------|--------------|------|
| **Binance** | None needed | - | Free |
| CoinGecko | `COINGECKO_API_KEY` | https://coingecko.com | Free tier |
| CoinMarketCap | `EXCHANGE_API_KEY` | https://pro.coinmarketcap.com | Free/Paid |
| Kraken | `EXCHANGE_API_KEY` + `EXCHANGE_API_SECRET` | https://www.kraken.com | Free |
| OKX | `EXCHANGE_API_KEY` + `EXCHANGE_API_SECRET` + `EXCHANGE_API_PASSWORD` | https://okx.com | Free |
| Coinbase | `EXCHANGE_API_KEY` + `EXCHANGE_API_SECRET` | https://coinbase.com | Free |

---

## Quick Fix Checklist

Run these commands in order:

```bash
# 1. Verify current exchange configuration
grep "EXCHANGE_NAME" .env

# 2. Change to Binance (no key needed)
sed -i 's/EXCHANGE_NAME=.*/EXCHANGE_NAME=binance/' .env

# 3. Restart the server (Ctrl+C the running one first)
npm run dev

# 4. Watch for price fetch logs - should see new data within 10 seconds
tail -f /tmp/claude-1000/-home-creekz-Projects-Shady-Trader/a3c82910-e47c-4d9b-8d69-1048fbabb362/tasks/bhbtmgc9i.output | grep -i price

# 5. Check database for new data
sqlite3 trading.db "SELECT MAX(time) FROM candles WHERE symbol='BTC/USDT';"
# Should show a recent timestamp (within last few minutes)
```

---

## Expected Result After Fix

Once properly configured, you should see:

1. **Server logs**: Regular price fetch messages every 5 seconds
2. **Database**: New candle rows being inserted every minute
3. **Frontend charts**: Live updating candlestick data
4. **System status**: Exchange showing as "connected" or "enabled"

---

## Additional Notes

### Market Data vs Price Data

- **MarketDataService**: Fetches global metrics (market cap, volume, fear/greed) - this works even without exchange API key
- **ExchangeConnector**: Fetches actual price ticks and candles - this is what requires the exchange API key

### Redis Dependency

The system uses Redis for job queues and state management. If Redis is unavailable (shown in logs as "connect ECONNREFUSED"), the system falls back to in-memory storage - this is fine for development but not recommended for production.

### Data Retention

The system keeps:
- 500 candles per symbol/timeframe combination (oldest are deleted)
- Market data is replaced on each fetch
- News is retained for 7 days