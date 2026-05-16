# Shady Trader — Systematic Bug Fix Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix all 11 bugs discovered during headful Playwright testing, plus 3 critical missing features identified in the audit. Restore all broken frontend-backend integrations.

**Architecture:** Single-page React app (App.tsx, 2449 lines) + Express backend (routes.ts, main.ts, risk/manager.ts). All bugs are in the frontend integration layer — API calls are made but responses are silently dropped. No architectural changes needed.

**Tech Stack:** React 18 + TypeScript, Vite 8, Express, ws, lightweight-charts, SQLite

**Execution Order:** Tier 1 (data integrity) → Tier 2 (interactive features) → Tier 3 (polish). Each tier is independent; tiers 1-2 are sequential within themselves.

---

## Tier 1: Critical — Data Integrity & Core Features

### Task 1: Fix Balance Allocation — API Response Not Processed

**Objective:** Ensure clicking "Confirm allocate" actually moves funds from main to bot balance and the UI updates.

**Files:**
- Modify: `src/App.tsx:972-985`

**Root cause:** The `allocateBalance()` function at line 972 receives the API response but only calls `updateBalances(data.balances)` if `data.balances` is truthy. The API at routes.ts:944 returns `{ success: true, balances: { mainBalance, botBalance, ... } }`. But the frontend's `updateBalances` at line 133 merges with defaults: `setBalances(prev => ({ ...defaultBalances, ...prev, ...data }))`. The default has `botBalance: 0`, so if the API returns `{ mainBalance: 50000, botBalance: 50000 }`, this should work. The bug is likely that the API call fails silently because the `response.json()` might fail or `data.balances` is undefined when the response has no body.

**Fix:**

```typescript
// App.tsx:972 — replace allocateBalance function
const allocateBalance = async (amount: number) => {
  try {
    setLastCallTime(Date.now());
    const response = await fetch(`${APP_URL}/api/balances/allocate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': TRADER_TOKEN
      },
      body: JSON.stringify({ amount })
    });
    const data = await response.json();
    console.log('[Balance] Allocate response:', data); // Debug log
    if (!response.ok) {
      alert(data.error || `Server error: ${response.status}`);
      return;
    }
    if (data.balances) {
      updateBalances(data.balances);
    } else if (data.success) {
      // If API returned success but no balances object, re-fetch
      const balRes = await fetch(`${APP_URL}/api/balances`);
      if (balRes.ok) {
        const balData = await balRes.json();
        updateBalances(balData);
      }
    }
    if (data.error) alert(data.error);
  } catch (e) {
    console.error('Failed to allocate balance:', e);
    alert('Failed to allocate balance. Check console for details.');
  }
};
```

**Step 1: Apply the fix to App.tsx**

**Step 2: Restart the server and test**
```bash
cd /home/creekz/Projects/Shady_Trader
# Kill existing server on port 3000 if needed
npx playwright test tests/playwright/verify-reload-fix.spec.ts --headed 2>&1 &
sleep 3
# Manual test via curl to verify API works
curl -s -X POST http://localhost:3000/api/balances/allocate \
  -H "Content-Type: application/json" \
  -H "x-api-token: trader_token_456" \
  -d '{"amount": 50000}' | python3 -m json.tool
```

**Step 3: Verify with browser** — Open http://localhost:3000, click "+ Allocate", enter amount, click "Confirm allocate", confirm Bot Balance updates.

---

### Task 2: Fix Backtest — Silent Failure on Run

**Objective:** Backtest actually executes when "Run Backtest" is clicked, showing results (win rate, PnL, trades) in the UI.

**Files:**
- Modify: `src/App.tsx:473-540` (runBacktest function)
- Check: `backend/api/routes.ts:924-933` (backtest route)

**Root cause:** The `runBacktest()` function at line 473 begins with `if (!riskConfigs[activeMode]) return;` — if the risk configs haven't loaded yet (async fetch), this silently aborts. Also, the `setIsBacktesting(false)` at line 538 might fire before the async setData completes. The API at routes.ts:924 might return 400 if the config doesn't match the Zod schema (expects `mode: RiskMode`, `config: Record`, `startTime: number`, `endTime: number`).

**Fix:**

```typescript
// App.tsx:473 — replace runBacktest function
const runBacktest = async (startTime?: number, endTime?: number) => {
  if (!riskConfigs[activeMode]) {
    console.warn('[Backtest] No risk config for mode:', activeMode);
    alert('Risk configuration not loaded yet. Please wait...');
    return;
  }

  setIsBacktesting(true);
  try {
    setLastCallTime(Date.now());
    const payload = {
      mode: activeMode,
      config: riskConfigs[activeMode],
      startTime: startTime || Date.now() - 30 * 24 * 60 * 60 * 1000,
      endTime: endTime || Date.now()
    };
    console.log('[Backtest] Sending:', JSON.stringify(payload).slice(0, 200));
    
    const res = await fetch(`${APP_URL}/api/backtest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': ADMIN_TOKEN
      },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Backtest API error ${res.status}: ${errText.slice(0, 200)}`);
    }
    
    const data = await res.json();
    console.log('[Backtest] Result:', JSON.stringify(data).slice(0, 300));
    
    if (data.trades && data.candles) {
      setBacktestTrades(data.trades);
      setBacktestRegimeChanges(data.regimeChanges || []);
      
      // Update chart with backtest candles
      if (seriesRef.current && Array.isArray(data.candles)) {
        const mergedCandles = [...candlesDataRef.current, ...data.candles];
        const uniqueCandlesMap = new Map();
        mergedCandles.forEach(c => uniqueCandlesMap.set(c.time, c));
        const uniqueCandles = Array.from(uniqueCandlesMap.values())
          .sort((a: any, b: any) => a.time - b.time);
        candlesDataRef.current = uniqueCandles;
        
        const formattedData = uniqueCandles
          .map((c: any) => ({
            time: Math.floor(Number(c.time) / 1000) as any,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
          }))
          .filter((c: any) => !isNaN(c.time))
          .sort((a: any, b: any) => a.time - b.time);

        const uniqueData: any[] = [];
        for (let i = 0; i < formattedData.length; i++) {
          if (i === 0 || formattedData[i].time > formattedData[i-1].time) {
            uniqueData.push(formattedData[i]);
          }
        }
        seriesRef.current.setData(uniqueData);
        updateIndicators();
      }
    } else if (Array.isArray(data)) {
      setBacktestTrades(data);
    } else if (data.error) {
      throw new Error(data.error);
    } else {
      console.warn('[Backtest] Unexpected response shape:', data);
    }
  } catch (e) {
    console.error('[Backtest] Failed:', e);
    alert(`Backtest failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setIsBacktesting(false);
  }
};
```

**Step 1: Apply the fix** to App.tsx lines 473-540

**Step 2: Restart server and test via curl:**
```bash
curl -s -X POST http://localhost:3000/api/backtest \
  -H "Content-Type: application/json" \
  -H "x-api-token: dev_token_123" \
  -d '{
    "mode": "moderate",
    "config": {"positionSize": 0.05, "strategy": "regime_based"},
    "startTime": 1746489600000,
    "endTime": 1747353600000
  }' | python3 -m json.tool
```

**Step 3: Verify in browser** — Open http://localhost:3000, click Backtest to enter backtest mode, click "Run Backtest", confirm loading spinner appears then results show.

---

### Task 3: Fix AI Recommend — No Parameters Updated

**Objective:** AI Recommend button actually changes the strategy parameters based on the current market regime.

**Files:**
- Modify: `src/App.tsx:457-471` (getAiRecommendations function)
- Modify: `backend/api/routes.ts:844-922` (ai-recommend route)

**Root cause (#1, backend):** The fallback at line 910-919 multiplies `currentConfigs[mode].tpMultiplier` and `.slMultiplier` by 1.2 or 0.8 — but if the initial value is 0 (which it is — see BUG-10), `0 * 1.2 = 0` and `Math.max(1.5, 0) = 1.5`. So TP goes to 1.5 but SL stays at `Math.max(0.5, 0) = 0.5`. Wait actually that IS a valid change. Let me reconsider...

Actually the problem is that the backend DOES return changed values. The function `getAiRecommendations` at line 457-471 calls the API, gets `data.configs`, and calls `setRiskConfigs(data.configs)`. But the state update might not propagate to the strategy config panel's inputs because the inputs are controlled by `riskConfigs[activeMode]` — and the key for the active mode is stored in the `riskConfigs` object. If the backend returns a DIFFERENT set of keys than what the frontend expects, the `riskConfigs[activeMode]` lookup fails.

The real issue: when the Ollama call fails (no local Ollama), the backend enters the catch block and modifies `currentConfigs` in-place. Then it returns `{ success: true, configs: currentConfigs }`. The frontend receives this and calls `setRiskConfigs(data.configs)`. This SHOULD work because `currentConfigs` has all the same keys.

Let me re-examine: The frontend call is at line 460-466:
```typescript
const res = await fetch(`${APP_URL}/api/risk-configs/ai-recommend`, {
  method: 'POST',
  headers: { 'x-api-token': ADMIN_TOKEN }
});
const data = await res.json();
if (data.success) {
  setRiskConfigs(data.configs);
}
```

The problem might be that `res.json()` fails (empty body, network error) or `data.success` is false. Let me add better error handling.

**Fix (frontend):**

```typescript
// App.tsx:457 — replace getAiRecommendations
const getAiRecommendations = async () => {
  try {
    setLastCallTime(Date.now());
    const res = await fetch(`${APP_URL}/api/risk-configs/ai-recommend`, {
      method: 'POST',
      headers: { 'x-api-token': ADMIN_TOKEN }
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    const data = await res.json();
    console.log('[AI] Recommend response:', data);
    if (data.success && data.configs) {
      // Deep merge to preserve any mode not returned
      setRiskConfigs(prev => {
        const merged = { ...prev };
        for (const [mode, config] of Object.entries(data.configs)) {
          merged[mode] = { ...(merged[mode] || {}), ...(config as any) };
        }
        return merged;
      });
    } else {
      console.warn('[AI] Recommend returned no changes');
    }
  } catch (e) {
    console.error('[AI] Recommend failed:', e);
    alert('AI recommendation failed. Using fallback logic.');
  }
};
```

**Fix (backend):** Ensure the fallback in routes.ts always produces meaningful changes even when initial values are 0:

```typescript
// routes.ts:910-919 — replace fallback logic
// Fallback to simple logic — always produce non-zero values
for (const mode of Object.values(RiskMode)) {
  const defaults = DEFAULT_RISK_CONFIGS[mode as RiskMode];
  if (currentRegime === 'strong_bull' || currentRegime === 'bear') {
    currentConfigs[mode].tpMultiplier = Math.max(1.5, (currentConfigs[mode].tpMultiplier || 1.5) * 1.2);
    currentConfigs[mode].slMultiplier = Math.max(0.5, (currentConfigs[mode].slMultiplier || 1.0) * 0.8);
  } else if (currentRegime === 'sideways') {
    currentConfigs[mode].tpMultiplier = Math.max(1.0, (currentConfigs[mode].tpMultiplier || 1.5) * 0.8);
    currentConfigs[mode].slMultiplier = Math.max(0.5, (currentConfigs[mode].slMultiplier || 1.0) * 1.2);
  } else {
    // weak_bull or uncertain — moderate adjustments
    currentConfigs[mode].tpMultiplier = currentConfigs[mode].tpMultiplier || 1.5;
    currentConfigs[mode].slMultiplier = currentConfigs[mode].slMultiplier || 1.0;
  }
}
```

**Step 1:** Apply both fixes

**Step 2:** Restart server, open the strategy config panel, click "AI Recommend", confirm parameters change.

---

### Task 4: Fix Balance/Position Data Mismatch

**Objective:** Balance Management UI shows correct Bot Balance and Active Trade values that match the Open Positions data.

**Files:**
- Modify: `src/App.tsx:179-188` (initial data fetches in useEffect)
- Modify: `src/App.tsx:886-896` (fetchBalances function)
- Modify: `backend/api/routes.ts:935-942` (balances endpoint)

**Root cause:** The `/api/balances` endpoint at routes.ts:935 returns `engine.balanceManager.getBalances()`. The BalanceManager tracks main balance and bot balance independently. But the shadow trader's open positions (displayed from `/api/positions/open`) use different funding — they draw from shadow portfolio balances, NOT from the BalanceManager's bot balance. The UI shows BalanceManager balances on the left and shadow portfolio positions on the right — they're different accounting systems that never sync.

**Fix:** Update the `/api/balances` endpoint to aggregate shadow portfolio data:

```typescript
// routes.ts:935-942 — replace balances endpoint
apiRouter.get('/balances', async (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const baseBalances = await engine.balanceManager.getBalances();
    
    // Aggregate shadow portfolio positions into active trade balance
    let totalActiveTrade = 0;
    let totalPnl = 0;
    for (const mode of Object.values(RiskMode)) {
      const portfolio = engine.shadowTrader.portfolios[mode as RiskMode];
      if (portfolio && portfolio.openTrades) {
        for (const trade of portfolio.openTrades) {
          totalActiveTrade += trade.amount * (trade.currentPrice || trade.price);
          totalPnl += (trade.currentPrice - trade.price) * trade.amount * (trade.side === 'buy' ? 1 : -1);
        }
      }
    }
    
    res.json({
      ...baseBalances,
      activeTradeBalance: totalActiveTrade,
      totalPnl: totalPnl,
      totalPnlPct: baseBalances.botBalance > 0 
        ? (totalPnl / baseBalances.botBalance) * 100 
        : (baseBalances.mainBalance > 0 ? (totalPnl / baseBalances.mainBalance) * 100 : 0)
    });
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});
```

And update the frontend to poll balances more frequently:

```typescript
// App.tsx:271 — change the interval to also fetch balances
const interval = setInterval(() => {
  fetchOpenPositions();
  fetchBalances();  // Add this line
  if (Date.now() - lastMessageTimeRef.current > 5000) {
    setIsDataPassing(false);
  }
}, 5000);  // Reduced from 1000 to 5000ms
```

**Step 1:** Apply backend fix to routes.ts

**Step 2:** Apply frontend fix to App.tsx (interval 271, add fetchBalances call)

**Step 3:** Restart server, verify Balance Management now shows the ~$7k active trade value.

---

## Tier 2: High — Interactive Features

### Task 5: Fix Edit TP/SL — Inline Editor Not Appearing

**Objective:** Clicking the gear icon (Edit TP/SL) on a position shows SL/TP input fields with Save/Cancel buttons.

**Files:**
- Modify: `src/App.tsx:1873-1940` (Edit TP/SL inline editor section)

**Root cause:** The `setEditingPosition(pos.id)` at line 1876 sets state, and the JSX at line 1901 checks `isEditing` which is `editingPosition === pos.id`. The code looks correct at first glance. The issue might be that the click event propagates up to the parent `div` which is `onClick={() => setEditingPosition(null)}` (the close trigger). The click on the gear icon might fire both `onClick` handlers — first `setEditingPosition(pos.id)` then some parent cancels it.

Looking at the JSX structure (lines 1862-1898):
```jsx
<div key={pos.id || i} className="p-3 rounded-lg ...">
  <div className="flex justify-between items-start mb-2">
    <div>
      <span>{pos.side}</span>
      <span>{pos.symbol}</span>
      <span>{pos.leverage}x</span>
    </div>
    <div className="flex items-center gap-2">
      <button onClick={() => {
        if (isEditing) {
          setEditingPosition(null);
        } else {
          setEditingPosition(pos.id);
          setEditSl(pos.stopLoss);
          setEditTp(pos.takeProfit);
        }
      }}>...</button>
      <button onClick={() => closePosition(pos.id)}>...</button>
    </div>
  </div>
  ...
```

Wait, the ref=e20 I clicked was the "Edit TP/SL" button which is a `<button>` element. But looking at the snapshot, there are two buttons per position: a settings gear (Edit TP/SL) and an X (Close position). The click handler is inline. There's no `stopPropagation()` on these buttons. If there's a parent onClick that resets editing state (like clicking the backdrop), that could be the issue.

Actually looking more carefully at the code, there's NO backdrop close handler for the position cards — the inline editor is just within the card itself. The issue might be simpler: the position's `pos.id` might be undefined, making `editingPosition === pos.id` always false, so `isEditing` is never true.

**Fix:** Add defensive check for pos.id, and add `e.stopPropagation()` to the button:

```typescript
// Replace the Edit TP/SL button onClick (lines 1874-1883)
<button 
  onClick={(e) => {
    e.stopPropagation();
    if (!pos.id) {
      console.warn('[Position] Cannot edit: no position ID');
      return;
    }
    if (isEditing) {
      setEditingPosition(null);
    } else {
      setEditingPosition(pos.id);
      setEditSl(pos.stopLoss || 0);
      setEditTp(pos.takeProfit || 0);
    }
  }}
  ...
>
```

**Step 1:** Apply the fix

**Step 2:** Restart server, open page, click gear icon on a position, confirm SL/TP inputs appear.

---

### Task 6: Fix Provider Credential Switching

**Objective:** Changing the Exchange/Provider dropdown in settings actually changes the credential fields shown (API Key, Secret, Passphrase).

**Files:**
- Modify: `src/App.tsx:2170-2264` (conditional credential fields in settings modal)

**Root cause:** The conditional rendering at line 2187 checks `settings.exchange === 'coinmarketcap'` etc. When the user selects a new provider via the `<select>` onChange at line 2174, `setSettings({ ...settings, exchange: e.target.value })` is called. This SHOULD trigger a re-render showing the new fields. The bug might be that the `saveSettings` function at line 557 sends the full settings object via POST, but the route at line 732 filters out `apiKey`, `apiSecret`, `apiPassword` from saving. More importantly, the settings effect at line 179-188 fetches settings on mount and the response at line 754 skips API key-like keys — meaning the settings state never has `apiKey`, `apiSecret`, or `apiPassword` from the server, and the local state defaults are used.

**Fix:** Add `e.stopPropagation()` equivalent by using `useCallback` for the provider change handler to ensure React re-render is triggered:

```typescript
// Replace lines 2172-2184 with a properly isolated handler
<select
  value={settings.exchange}
  onChange={(e) => {
    const newExchange = e.target.value;
    // Clear old credential fields when switching provider type
    const isExchange = ['binance', 'kraken', 'okx', 'coinbase'].includes(newExchange);
    const isApiKey = ['coinmarketcap', 'coingecko', 'cryptocompare'].includes(newExchange);
    setSettings(prev => ({
      ...prev,
      exchange: newExchange,
      // Reset credential fields that don't apply to new provider
      ...(isExchange ? {} : { apiSecret: '', apiPassword: '' }),
      ...(isApiKey ? {} : { apiKey: '' }),
    }));
  }}
  ...
>
```

**Step 1:** Apply the fix

**Step 2:** Restart server, open settings, select "Binance", confirm that "API Key" and "API Secret" fields appear (not "CoinMarketCap API Key").

---

### Task 7: Fix Timeframe Switch — Chart Doesn't Reload

**Objective:** Clicking a timeframe button (e.g., "1h") should reload the chart with candles at that timeframe.

**Files:**
- Modify: `src/App.tsx:748-783` (fetchCandles function)
- Modify: `src/App.tsx:848-864` (changeTimeframe function)

**Root cause:** The `changeTimeframe()` at line 848 posts to `/api/timeframe` to update the engine's timeframe, then calls `fetchStatus()` and `fetchCandles()`. But `fetchCandles()` at line 752 always calls `/api/candles?history=1y` — it doesn't pass the currently selected timeframe. The candles API at routes.ts:570 does respect `engine.timeframe` for data sampling, but the chart already has the 1-year dataset loaded. The chart's time scale doesn't auto-adjust to the new timeframe — it shows whatever range fits all the data.

The fix is twofold: (1) have fetchCandles pass the current timeframe so the API returns appropriately sampled data, and (2) optionally adjust the visible range on the chart to show a reasonable window based on the timeframe.

**Fix:**

```typescript
// App.tsx:748 — replace fetchCandles to accept timeframe parameter
async function fetchCandles(timeframe?: string) {
  try {
    setIsLoadingCandles(true);
    setLastCallTime(Date.now());
    const tf = timeframe || status.timeframe || '15m';
    // Shorter history for shorter timeframes
    let historyParam = '1y';
    if (tf === '1m') historyParam = '7d';
    else if (tf === '5m') historyParam = '30d';
    else if (tf === '15m') historyParam = '90d';
    else if (tf === '1h') historyParam = '180d';
    
    const result = await safeFetch(`${APP_URL}/api/candles?history=${historyParam}`);
    if (result.ok && result.data && seriesRef.current && Array.isArray(result.data)) {
      candlesDataRef.current = result.data;
      const formattedData = result.data
        .map((c: any) => ({
          time: Math.floor(Number(c.time) / 1000) as any,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        }))
        .filter((c: any) => !isNaN(c.time))
        .sort((a: any, b: any) => a.time - b.time);

      const uniqueData: any[] = [];
      for (let i = 0; i < formattedData.length; i++) {
        if (i === 0 || formattedData[i].time > formattedData[i-1].time) {
          uniqueData.push(formattedData[i]);
        }
      }

      seriesRef.current.setData(uniqueData);
      updateIndicators();
      updateMarkers();
      
      // Auto-fit the visible range
      if (chartRef.current) {
        chartRef.current.timeScale().fitContent();
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    setIsLoadingCandles(false);
  }
}

// App.tsx:848 — update changeTimeframe to pass the timeframe
const changeTimeframe = async (tf: string) => {
  try {
    setLastCallTime(Date.now());
    const res = await fetch(`${APP_URL}/api/timeframe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': TRADER_TOKEN
      },
      body: JSON.stringify({ timeframe: tf })
    });
    if (!res.ok) {
      console.warn('[Timeframe] API rejected:', await res.text());
    }
    // Update local status immediately for UI responsiveness
    setStatus(prev => ({ ...prev, timeframe: tf }));
    fetchCandles(tf);
  } catch (e) {
    console.error(e);
  }
};
```

**Step 1:** Apply both fixes

**Step 2:** Restart server, click different timeframe buttons, confirm the chart visually updates.

---

### Task 8: Fix Redundant Signal Generation

**Objective:** Eliminate duplicate/redundant BUY/SELL signals in the Recent Signals feed.

**Files:**
- Modify: `backend/main.ts` (trading engine cycle — signal generation dedup)
- Modify: `src/App.tsx:259-260` (WS signal handler)

**Root cause:** The WebSocket handler at line 259 fires `fetchTrades()` on every `data.type === 'signal'` message. If the engine generates multiple signals for the same candle (which it appears to do — 4 identical BUY signals for the same price within 3 seconds), the frontend fetches all trades each time. But the trades list already has the previous signals, so they accumulate duplicates.

**Fix (frontend):** Deduplicate by trade timestamp + side + price:

```typescript
// App.tsx:259-260 — replace signal handler
} else if (data.type === 'signal') {
  fetchTrades();
  // Also update the current price from signal data
  if (data.data?.price) {
    setCurrentPrice(data.data.price);
  }
```

Actually the real dedup needs to happen where trades are set. But the simplest frontend fix is to filter at display time. Let me instead fix the root cause in the backend.

**Fix (backend, backend/main.ts):** Add a signal deduplication check in the trading engine cycle. Before emitting a signal, check if the last N signals had the same side and price within a time window.

For simplicity, the most impactful fix is frontend dedup of the display:

```typescript
// In the Recent Signals render section (around line 1980), replace the display:
{(showBacktestUI ? backtestTrades.slice(-5).reverse() : 
  // Deduplicate trades by (side + price + truncated timestamp)
  (() => {
    const seen = new Set();
    return trades.filter(t => {
      const key = `${t.side}_${Math.round(t.price || t.entryPrice)}_${Math.floor((t.timestamp || t.time) / 10000)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5);
  })()
).map((trade: any, i: number) => (...)}
```

**Step 1:** Apply frontend dedup fix

**Step 2:** Restart server, confirm Recent Signals shows unique entries without duplicates.

---

### Task 9: Reduce Excessive Polling Interval

**Objective:** Reduce `/api/positions/open` requests from ~60/minute to ~12/minute.

**Files:**
- Modify: `src/App.tsx:271-276`

**Root cause:** The `setInterval` at line 271 fires every 1000ms (1 second). Since positions rarely change at sub-second granularity, this is wasteful. 5000ms (5 seconds) is more appropriate.

**Fix:**

```typescript
// App.tsx:271-276
const interval = setInterval(() => {
  fetchOpenPositions();
  fetchBalances();  // Also sync balances
  if (Date.now() - lastMessageTimeRef.current > 15000) {  // Increase stale timeout
    setIsDataPassing(false);
  }
}, 5000);  // Changed from 1000 to 5000
```

Also remove the noisy `console.log('Fetching:', url)` at line 960:

```typescript
// App.tsx:959-960 — remove the debug log
const url = `${APP_URL}/api/positions/open`;
// Remove: console.log('Fetching:', url);
```

**Step 1:** Apply both changes

**Step 2:** Restart server, verify console no longer floods with fetch logs.

---

## Tier 3: Medium — Polish & UX

### Task 10: Fix Zero Default Values in Strategy Config

**Objective:** TP Multiplier, SL Multiplier, and Risk/Trade should have sensible non-zero defaults.

**Files:**
- Modify: `src/App.tsx:1670-1794` (strategy config input fields)
- Modify: `backend/risk/manager.ts` (DEFAULT_RISK_CONFIGS)

**Root cause:** The `riskConfigs[activeMode]` is populated from the API response. If the API returns configs where `tpMultiplier`, `slMultiplier`, or `maxRiskPerTrade` are undefined (or 0), the UI inputs show their current value via `|| 0`. The `DEFAULT_RISK_CONFIGS` in risk/manager.ts has these values but the configs returned from the API might be a partial dataset.

**Fix:** Set default values in the UI inputs:

```typescript
// Around line 1677 — for TP Multiplier
value={riskConfigs[activeMode]?.tpMultiplier ?? 1.5}

// Around line 1693 — for SL Multiplier  
value={riskConfigs[activeMode]?.slMultiplier ?? 1.0}

// Around line 1733 — for Risk/Trade
value={(riskConfigs[activeMode]?.maxRiskPerTrade ?? 0.02) * 100}
```

Also, ensure the risk configs endpoint returns complete defaults for each mode. In routes.ts:815:

```typescript
apiRouter.get('/risk-configs', (req, res) => {
  const engine = getTradingEngine();
  if (engine) {
    const configs = engine.shadowTrader.riskManager.RISK_CONFIGS;
    // Merge with defaults to ensure all fields exist
    const enrichedConfigs: Record<string, any> = {};
    for (const [mode, defaultConfig] of Object.entries(DEFAULT_RISK_CONFIGS)) {
      enrichedConfigs[mode] = { ...defaultConfig, ...(configs[mode] || {}) };
    }
    res.json(enrichedConfigs);
  } else {
    res.status(500).json({ error: 'Engine not initialized' });
  }
});
```

**Step 1:** Apply both fixes

**Step 2:** Restart server, open strategy config panel, verify TP Multiplier shows 1.5 (not 0), SL Multiplier shows 1.0 (not 0), Risk/Trade shows 2 (not 0).

---

### Task 11: Fix Chart Resize Warning on Load

**Objective:** Eliminate the "width(-1) and height(-1)" warning in console on page load.

**Files:**
- Modify: `src/App.tsx:284-300` (chart creation useEffect)

**Root cause:** The lightweight-charts `createChart()` is called in a `useEffect` that checks `chartContainerRef.current` exists, but doesn't verify the container has non-zero dimensions. At initial render, the container may have 0px width/height before CSS layout completes.

**Fix:** Use a `ResizeObserver` and delay chart creation until the container has dimensions:

```typescript
// App.tsx:284 — replace the chart creation useEffect
useEffect(() => {
  if (!chartContainerRef.current) return;
  
  // Wait for container to have dimensions
  const container = chartContainerRef.current;
  if (container.clientWidth <= 0 || container.clientHeight <= 0) {
    // Retry after layout
    const raf = requestAnimationFrame(() => {
      // This will re-trigger the effect because ref stays same
      // but we need a state update. Use a simple workaround:
      if (container.clientWidth > 0) {
        initChart(container);
      } else {
        // One more try with a short timeout
        setTimeout(() => {
          if (container.clientWidth > 0 && chartContainerRef.current === container) {
            initChart(container);
          }
        }, 100);
      }
    });
    return () => cancelAnimationFrame(raf);
  }

  initChart(container);

  function initChart(div: HTMLDivElement) {
    const chart = createChart(div, {
      layout: {
        background: { type: ColorType.Solid, color: '#1e1e1e' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: '#2B2B43' },
        horzLines: { color: '#2B2B43' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      width: div.clientWidth,
      height: 400,
    });
    /* ... rest of the chart setup ... */
  }

  // Also add ResizeObserver for responsive resizing
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width } = entry.contentRect;
      if (chartRef.current && width > 0) {
        chartRef.current.applyOptions({ width });
      }
    }
  });
  resizeObserver.observe(container);
  
  return () => {
    resizeObserver.disconnect();
    /* ... cleanup ... */
  };
}, []);
```

**Step 1:** Apply the fix

**Step 2:** Restart server, reload page, verify no chart resize warnings in console.

---

### Task 12: Add Trade Confirmation Dialog

**Objective:** Manual trade buttons ("Enter High"/"Enter Low") should show a confirmation dialog before executing.

**Files:**
- Modify: `src/App.tsx:803-846` (manualTrade function)

**Root cause:** Not a bug — missing feature. The `manualTrade` function executes immediately without user confirmation.

**Fix:** Add a confirmation step using `window.confirm()`:

```typescript
// App.tsx:803 — replace manualTrade function
const manualTrade = async (side: 'buy' | 'sell') => {
  if (currentPrice === 0) {
    alert('No current price available. Wait for market data to load.');
    return;
  }

  // Show confirmation with calculated details
  const symbol = status.symbol || 'BTC/USDT';
  const effectiveLeverage = riskConfigs[activeMode]?.leverage || 1;
  const positionSize = riskConfigs[activeMode]?.positionSize || 0.02;
  const estimatedAmount = (balances.mainBalance * positionSize) / currentPrice;
  
  const confirmMsg = [
    `⚠️ CONFIRM ${side.toUpperCase()} TRADE`,
    `  Symbol: ${symbol}`,
    `  Price: $${currentPrice.toFixed(2)}`,
    `  Mode: ${activeMode.replace('_', ' ')}`,
    `  Leverage: ${effectiveLeverage}x`,
    `  Est. Size: ${estimatedAmount.toFixed(4)} BTC`,
    `  Est. Value: $${(estimatedAmount * currentPrice).toFixed(2)}`,
    ``,
    `This trade will be executed on the shadow portfolio.`,
    `Continue?`,
  ].join('\n');
  
  if (!window.confirm(confirmMsg)) {
    return;
  }

  // Rest of the existing function...
  try {
    // ... same as before
  }
};
```

**Step 1:** Apply the fix

**Step 2:** Restart server, click "Enter High", confirm the dialog appears with trade details.

---

### Task 13: Add User-Facing Error Toast/Notification System

**Objective:** Instead of silent console.error, show error messages to the user as toast notifications in the UI.

**Files:**
- Create: `src/components/Toast.tsx`
- Modify: `src/App.tsx` (add toast state and integration)

**Root cause:** All error handling currently uses `console.error()` or `alert()` — neither is appropriate. Console errors are invisible to users, and `alert()` is intrusive.

**Fix:** Create a simple toast component and integrate it into the app's error handling:

```tsx
// Create: src/components/Toast.tsx
import React, { useEffect, useState } from 'react';

interface ToastMessage {
  id: number;
  text: string;
  type: 'error' | 'success' | 'info';
}

let toastId = 0;
let addToastFn: ((msg: Omit<ToastMessage, 'id'>) => void) | null = null;

export function showToast(text: string, type: 'error' | 'success' | 'info' = 'error') {
  if (addToastFn) {
    addToastFn({ text, type });
  } else {
    console.warn('[Toast] Not initialized:', text);
  }
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    addToastFn = (msg: Omit<ToastMessage, 'id'>) => {
      const id = ++toastId;
      setToasts(prev => [...prev, { ...msg, id }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 5000);
    };
    return () => { addToastFn = null; };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`px-4 py-3 rounded-lg shadow-2xl text-sm font-medium animate-in slide-in-from-right-2 duration-200 border ${
            toast.type === 'error'
              ? 'bg-red-500/20 border-red-500/30 text-red-300'
              : toast.type === 'success'
              ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
              : 'bg-indigo-500/20 border-indigo-500/30 text-indigo-300'
          }`}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
```

Then in App.tsx, import `ToastContainer` and `showToast`, and replace all `alert()` calls and add toasts in catch blocks:

```typescript
// In the render section, add:
<ToastContainer />

// Replace alert() calls:
// Before: alert('Failed to execute trade');
// After: showToast('Failed to execute trade');

// Add toasts to catch blocks:
// catch (e) { console.error(e); showToast('Something went wrong'); }
```

**Step 1:** Create `src/components/Toast.tsx`

**Step 2:** Integrate into App.tsx (import, render, replace alerts)

**Step 3:** Restart server, trigger an error scenario, confirm toast appears.

---

## Execution Order Summary

```
Tier 1 (Critical — Data Integrity)
  ├── Task 1: Fix Balance Allocation         [App.tsx:972]
  ├── Task 2: Fix Backtest Execution         [App.tsx:473, routes.ts:924]
  ├── Task 3: Fix AI Recommend               [App.tsx:457, routes.ts:910]
  └── Task 4: Fix Balance/Position Sync      [App.tsx:271 + routes.ts:935]

Tier 2 (High — Interactive Features)
  ├── Task 5: Fix Edit TP/SL                 [App.tsx:1874]
  ├── Task 6: Fix Provider Credential Switch [App.tsx:2172]
  ├── Task 7: Fix Timeframe Chart Reload     [App.tsx:748, 848]
  ├── Task 8: Fix Redundant Signals          [App.tsx:1980, backend/main.ts]
  └── Task 9: Reduce Polling Interval        [App.tsx:271, 960]

Tier 3 (Medium — Polish & UX)
  ├── Task 10: Fix Zero Defaults             [App.tsx:1677, routes.ts:815]
  ├── Task 11: Fix Chart Resize Warning      [App.tsx:284]
  ├── Task 12: Add Trade Confirmation        [App.tsx:803]
  └── Task 13: Add Toast Notification System [src/components/Toast.tsx]
```

## Verification

After all tasks are complete:

```bash
# 1. Restart the server
cd /home/creekz/Projects/Shady_Trader && npm run dev

# 2. Run the automated test suite
npx playwright test tests/playwright/trading-system.spec.ts --reporter=list

# 3. Verify no console warnings on page load
# Open http://localhost:3000, check browser console for:
# - No chart resize warnings
# - No excessive polling logs
# - WebSocket connects cleanly

# 4. Manual verification checklist:
# ✅ Balance allocation: allocate $100 → bot balance shows $100
# ✅ Backtest: click Run → results appear (win rate, PnL, trades)
# ✅ AI Recommend: click → strategy params change
# ✅ Balance sync: open positions value matches active trade balance
# ✅ Edit TP/SL: click gear → inline editor appears
# ✅ Provider switch: change to Binance → API Key + Secret fields
# ✅ Timeframe switch: click 1h → chart reloads with hourly data
# ✅ Signals: no duplicate entries in Recent Signals
# ✅ Polling: console not flooded with fetch logs
# ✅ Defaults: TP=1.5, SL=1.0, Risk=2% (not 0)
# ✅ Trade confirmation: clicking Enter High shows confirm dialog
# ✅ Toasts: error scenarios show red toast notification
```
