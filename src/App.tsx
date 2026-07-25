/**
 * App.tsx — Composition Root (T12)
 *
 * This file was a 3392-line monolith. It is now a thin composition root that:
 *   - Manages top-level shared state (status, performance, trades, balances, etc.)
 *   - Fetches data from the API via the shared safeFetch client
 *   - Wires the useTradingWebSocket hook for real-time updates
 *   - Composes the 6 feature components + FreqtradePanel as props-down/callbacks-up
 *
 * T2 invariant: tokens come from the in-memory token store (src/auth/tokenStore.ts).
 * T3 invariant: the WS sends {type:'auth', token} as its first message (no query-string secret).
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Activity, TrendingUp, TrendingDown, Minus, AlertCircle, X, ExternalLink, Database as DatabaseIcon, Brain } from 'lucide-react';
import { safeFetch, APP_URL, adminToken, traderToken, debug } from './api/client';
import { setTokens, getTraderToken } from './auth/tokenStore';
import { useTradingWebSocket } from './hooks/useTradingWebSocket';
import ChartPanel, { IndicatorToggles } from './components/ChartPanel';
import TradeTables from './components/TradeTables';
import BalanceControls from './components/BalanceControls';
import BacktestOverlay from './components/BacktestOverlay';
import RiskConfigModal from './components/RiskConfigModal';
import EngineControls from './components/EngineControls';
import FreqtradePanel from './components/FreqtradePanel';
import MLDashboard from './components/MLDashboard';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';

const StatusLight = ({ isLive, apiName, isDataPassing, lastCallTime }: { isLive: boolean; apiName: string; isDataPassing: boolean; lastCallTime: number }) => {
  const [isFlashing, setIsFlashing] = useState(false);
  useEffect(() => { if (lastCallTime > 0) { setIsFlashing(true); const t = setTimeout(() => setIsFlashing(false), 150); return () => clearTimeout(t); } }, [lastCallTime]);
  return (<div className="flex items-center gap-2"><div className={`w-3 h-3 rounded-full transition-all duration-100 ${isFlashing ? 'scale-125' : ''} ${isLive && isDataPassing ? (isFlashing ? 'bg-emerald-400 shadow-[0_0_15px_rgba(52,211,153,1)]' : 'bg-emerald-600 shadow-[0_0_10px_rgba(5,150,105,0.6)]') : 'bg-red-600 shadow-[0_0_10px_rgba(220,38,38,0.6)]'}`}></div><span className="text-xs text-gray-400 font-mono">{isLive && isDataPassing ? `API: ${apiName}` : 'OFFLINE'}</span></div>);
};
const getRegimeColor = (r: string) => r === 'strongbull' ? 'text-emerald-500 bg-emerald-500 bg-opacity-10 border border-emerald-500 border-opacity-20' : r === 'weakbull' ? 'text-green-400 bg-green-400 bg-opacity-10 border border-green-400 border-opacity-20' : r === 'bear' ? 'text-red-500 bg-red-500 bg-opacity-10 border border-red-500 border-opacity-20' : r === 'sideways' ? 'text-blue-400 bg-blue-400 bg-opacity-10 border border-blue-400 border-opacity-20' : 'text-gray-400 bg-gray-400 bg-opacity-10 border border-gray-400 border-opacity-20';
const getRegimeIcon = (r: string) => r === 'strongbull' || r === 'weakbull' ? <TrendingUp className="w-4 h-4" /> : r === 'bear' ? <TrendingDown className="w-4 h-4" /> : r === 'sideways' ? <Minus className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />;
const providerDocs: Record<string, string> = { coinmarketcap: 'https://coinmarketcap.com/api/documentation/v1/', coingecko: 'https://docs.coingecko.com/reference/coins-id-ohlc', coinapi: 'https://docs.coinapi.io', cryptocompare: 'https://min-api.cryptocompare.com/documentation/key=Historical&cat=dataHistoday', binance: 'https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data', kraken: 'https://docs.kraken.com/rest/endpoints/public/OHLC', okx: 'https://www.okx.com/docs-v5/en/#market-data', coinbase: 'https://docs.cloud.coinbase.com/exchange/reference/exchangerestapi_getproductcandles' };
const getProviderDocsUrl = (p: string) => providerDocs[p] || 'https://docs.coinapi.io';

const Toggle = ({ checked, onChange, color = 'indigo' }: { checked: boolean; onChange: (v: boolean) => void; color?: string }) => (
  <label className="relative inline-flex items-center cursor-pointer"><input type="checkbox" className="sr-only peer" checked={checked} onChange={(e) => onChange(e.target.checked)} /><div className={`w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:bg-${color}-500`}></div></label>
);

function TokenEntry({ onSubmit }: { onSubmit: (admin: string, trader: string) => void }) {
  const [admin, setAdmin] = useState(''); const [trader, setTrader] = useState(''); const [error, setError] = useState('');
  return (
    <div className="min-h-screen bg-[#121212] text-gray-100 p-6 font-sans flex items-center justify-center">
      <form onSubmit={(e) => { e.preventDefault(); if (!trader.trim()) { setError('Trader token is required.'); return; } onSubmit(admin.trim(), trader.trim()); }} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-bold">Operator Authentication</h1>
        <p className="text-sm text-gray-400">Enter API tokens to access the dashboard. Tokens are held in memory only and cleared on page reload.</p>
        <div><label className="block text-sm text-gray-400 mb-1">Admin token (optional)</label><input type="password" value={admin} onChange={e => setAdmin(e.target.value)} className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm" autoComplete="off" /></div>
        <div><label className="block text-sm text-gray-400 mb-1">Trader token (required)</label><input type="password" value={trader} onChange={e => setTrader(e.target.value)} className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm" autoComplete="off" /></div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" className="w-full px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">Enter Dashboard</button>
      </form>
    </div>
  );
}

function SignalConfidencePanel({ signalStatus, currentRegime }: { signalStatus: any; currentRegime: string }) {
  const conf = signalStatus?.hasSignal ? (signalStatus.signal?.confidence || 0) : (signalStatus?.liveConfidence || 0);
  const regimeStyle = (() => { const r = signalStatus?.regime || currentRegime; switch (r) { case 'strongbull': return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'; case 'weakbull': return 'bg-lime-500/20 text-lime-400 border border-lime-500/30'; case 'sideways': return 'bg-amber-500/20 text-amber-400 border border-amber-500/30'; case 'bear': return 'bg-red-500/20 text-red-400 border border-red-500/30'; default: return 'bg-gray-500/20 text-gray-400 border border-gray-500/30'; } })();
  const barColor = conf > 70 ? '#22c55e' : conf > 40 ? '#f59e0b' : conf > 20 ? '#ef4444' : '#6b7280';
  return (
    <div className="bg-[#1e1e1e] rounded-xl border border-white/10 p-3 min-w-[200px]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase ${regimeStyle}`}>{signalStatus?.regime || currentRegime}</span>
        {signalStatus?.hasSignal ? <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse">TRIGGERED</span> : <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse">AWAITING SIGNAL</span>}
      </div>
      <div className="space-y-1 mt-1">
        <div className="flex items-center justify-between">
          <span className={`text-xs font-bold ${signalStatus?.hasSignal ? (signalStatus.signal?.side === 'buy' ? 'text-emerald-400' : 'text-red-400') : (signalStatus?.liveSide === 'buy' ? 'text-emerald-400/70' : signalStatus?.liveSide === 'sell' ? 'text-red-400/70' : 'text-gray-400')}`}>
            {signalStatus?.hasSignal ? (signalStatus.signal?.side?.toUpperCase() || 'BUY') : (signalStatus?.liveSide?.toUpperCase() || '--')}
            {!signalStatus?.hasSignal && <span className="text-gray-500 text-[9px] ml-1">(live)</span>}
          </span>
          <span className="text-lg font-mono font-bold text-white">{conf}%</span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-1.5"><div className="h-1.5 rounded-full transition-all duration-700 ease-out" style={{ width: `${conf}%`, backgroundColor: barColor }} /></div>
        <div className="grid grid-cols-3 gap-1 text-[9px] mt-1">
          <div><span className="text-gray-500">Entry</span><div className="text-white font-mono">${signalStatus?.signal?.entryPrice?.toFixed(2) || '---'}</div></div>
          <div><span className="text-gray-500">SL</span><div className="text-red-400 font-mono">${signalStatus?.signal?.stopLoss?.toFixed(2) || '---'}</div></div>
          <div><span className="text-gray-500">TP</span><div className="text-emerald-400 font-mono">${signalStatus?.signal?.takeProfit?.toFixed(2) || '---'}</div></div>
        </div>
        {signalStatus?.signal?.reasoning && <div className="text-[9px] text-gray-400 italic truncate max-w-[200px]">{signalStatus.signal.reasoning}</div>}
        {signalStatus?.signal?.indicators?.length > 0 && <div className="flex flex-wrap gap-1 mt-1">{signalStatus.signal.indicators.map((ind: string, i: number) => <span key={i} className="text-[8px] px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/20">{ind}</span>)}</div>}
        {!signalStatus?.hasSignal && signalStatus?.liveIndicators?.length > 0 && <div className="flex flex-wrap gap-1 mt-1">{signalStatus.liveIndicators.map((ind: string, i: number) => <span key={i} className="text-[8px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-300/70 border border-amber-500/10">{ind}</span>)}</div>}
        {!signalStatus?.hasSignal && <div className="text-[9px] text-gray-500 italic animate-pulse mt-1">Waiting for next cycle...</div>}
        {signalStatus?.signal?.mlScore !== undefined && <div className="text-[9px] text-purple-400">ML: {signalStatus.signal.mlScore.toFixed(1)}%</div>}
      </div>
    </div>
  );
}

function SettingsModal({ settings, setSettings, onClose, onSave }: { settings: any; setSettings: React.Dispatch<React.SetStateAction<any>>; onClose: () => void; onSave: () => void }) {
  const inputCls = "w-full bg-[#1e1e1e] text-gray-300 border border-white/10 rounded-lg px-3 py-2 caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none text-sm";
  const isExchange = (e: string) => settings.exchange === e;
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#1e1e1e] border border-white/10 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-4 border-b border-white/5 flex-shrink-0"><h2 className="text-xl font-bold">System Settings</h2><button onClick={onClose} className="text-gray-400 hover:text-white focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none" aria-label="Close settings"><X className="w-5 h-5" /></button></div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div><label className="block text-sm font-medium text-gray-400 mb-1">Trading Pair</label><select value={settings.symbol} onChange={(e) => setSettings({ ...settings, symbol: e.target.value })} className={inputCls}><option value="BTC/USDT">BTC/USDT</option><option value="ETH/USDT">ETH/USDT</option><option value="SOL/USDT">SOL/USDT</option></select></div>
          <div><label className="block text-sm font-medium text-gray-400 mb-1">Timeframe</label><select value={settings.timeframe} onChange={(e) => setSettings({ ...settings, timeframe: e.target.value })} className={inputCls}><option value="1m">1m</option><option value="5m">5m</option><option value="15m">15m</option><option value="1h">1h</option><option value="4h">4h</option></select></div>
          <div className="pt-4 border-t border-white/5"><div className="flex items-center justify-between"><div><label className="text-sm font-medium text-gray-300">AI Strategy Switching</label><p className="text-xs text-gray-500 mt-1">Automatically switch modes based on market trend</p></div><Toggle checked={settings.aiStrategySwitching === 'true'} onChange={(v) => setSettings({ ...settings, aiStrategySwitching: v ? 'true' : 'false' })} /></div></div>
          <div className="pt-4 border-t border-white/5"><div className="flex items-center justify-between"><div><label className="text-sm font-medium text-amber-400">AI Signal Generation</label><p className="text-xs text-gray-500 mt-1">Use Gemini to confirm technical trade signals</p></div><Toggle checked={settings.aiSignalGeneration === 'true'} onChange={(v) => setSettings({ ...settings, aiSignalGeneration: v ? 'true' : 'false' })} color="amber" /></div></div>
          <div className="pt-4 border-t border-white/5"><div className="flex items-center justify-between"><div><label className="text-sm font-medium text-amber-400">AI Sentiment Analysis</label><p className="text-xs text-gray-500 mt-1">Use Gemini to gauge market sentiment for regime detection</p></div><Toggle checked={settings.aiSentimentAnalysis === 'true'} onChange={(v) => setSettings({ ...settings, aiSentimentAnalysis: v ? 'true' : 'false' })} color="amber" /></div></div>
          <div className="pt-4 border-t border-white/5"><div className="flex items-center justify-between mb-3"><h3 className="text-sm font-medium text-gray-300">Market Data Provider</h3><a href={getProviderDocsUrl(settings.exchange)} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1">Docs<ExternalLink className="w-3 h-3" /></a></div>
            <div className="space-y-3">
              <div><label className="block text-xs font-medium text-gray-400 mb-1">Exchange/Provider</label><select value={settings.exchange} onChange={(e) => setSettings({ ...settings, exchange: e.target.value })} className={inputCls}><option value="coinmarketcap">CoinMarketCap</option><option value="coingecko">CoinGecko</option><option value="coinapi">CoinAPI.io</option><option value="cryptocompare">CryptoCompare</option><option value="binance">Binance</option><option value="kraken">Kraken</option><option value="okx">OKX</option><option value="coinbase">Coinbase</option></select></div>
              <div><label className="block text-xs font-medium text-gray-400 mb-1">API Key</label><input type="password" value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder={`Enter your ${settings.exchange} API key`} className={inputCls} /></div>
              {(isExchange('binance') || isExchange('kraken') || isExchange('okx') || isExchange('coinbase')) && <div><label className="block text-xs font-medium text-gray-400 mb-1">API Secret</label><input type="password" value={settings.apiSecret} onChange={(e) => setSettings({ ...settings, apiSecret: e.target.value })} placeholder={`Enter your ${settings.exchange} API secret`} className={inputCls} /></div>}
              {isExchange('coinbase') && <div><label className="block text-xs font-medium text-gray-400 mb-1">API Passphrase</label><input type="password" value={settings.apiPassword || ''} onChange={(e) => setSettings({ ...settings, apiPassword: e.target.value })} placeholder="Enter your Coinbase API passphrase" className={inputCls} /></div>}
            </div>
          </div>
          <div className="pt-4 border-t border-white/5"><h3 className="text-sm font-medium text-gray-300 mb-3">System Configuration</h3><div className="space-y-3">
            <div><label className="block text-xs font-medium text-gray-400 mb-1">Base URL</label><input type="text" value={settings.baseUrl} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} placeholder="https://api.example.com" className={inputCls} /></div>
            <div><label className="block text-xs font-medium text-gray-400 mb-1">WebSocket URL</label><input type="text" value={settings.wsUrl} onChange={(e) => setSettings({ ...settings, wsUrl: e.target.value })} placeholder="wss://ws.example.com" className={inputCls} /></div>
            <div><label className="block text-xs font-medium text-gray-400 mb-1">System JSON Config</label><textarea value={settings.systemJsonConfig} onChange={(e) => setSettings({ ...settings, systemJsonConfig: e.target.value })} placeholder='{"key": "value"}' className={`${inputCls} font-mono h-24`} /></div>
          </div></div>
          <div className="pt-4 border-t border-white/5"><h3 className="text-sm font-medium text-gray-300 mb-3">Strategy Settings</h3><div className="space-y-3">
            <div><label className="block text-xs font-medium text-gray-400 mb-1">Trading Strategy</label><select value={settings.strategy} onChange={(e) => setSettings({ ...settings, strategy: e.target.value })} className={inputCls}><option value="regime">Regime Based</option><option value="shotgun">Shotgun</option><option value="alt_chaser">Alt Chaser</option><option value="chasing_dragons">Chasing Dragons</option></select></div>
            {settings.strategy === 'shotgun' && <div className="grid grid-cols-2 gap-2"><input type="number" value={settings.shotgunTimeBefore} onChange={(e) => setSettings({ ...settings, shotgunTimeBefore: e.target.value })} placeholder="Time Before (s)" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white" /><input type="number" value={settings.shotgunTimeAfter} onChange={(e) => setSettings({ ...settings, shotgunTimeAfter: e.target.value })} placeholder="Time After (s)" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white" /></div>}
            {settings.strategy === 'alt_chaser' && <input type="number" value={settings.altChaserPercentage} onChange={(e) => setSettings({ ...settings, altChaserPercentage: e.target.value })} placeholder="Percentage Change" className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white" />}
            {settings.strategy === 'chasing_dragons' && <div className="grid grid-cols-2 gap-2"><input type="number" value={settings.chasingDragonsLeverage} onChange={(e) => setSettings({ ...settings, chasingDragonsLeverage: e.target.value })} placeholder="Leverage" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white" /><input type="number" value={settings.chasingDragonsStopLoss} onChange={(e) => setSettings({ ...settings, chasingDragonsStopLoss: e.target.value })} placeholder="Stop Loss %" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white" /></div>}
            <div className="flex items-center justify-between pt-2"><label className="text-sm font-medium text-gray-400">Use Testnet</label><Toggle checked={settings.testnet === 'true'} onChange={(v) => setSettings({ ...settings, testnet: v ? 'true' : 'false' })} /></div>
          </div></div>
        </div>
        <div className="p-4 border-t border-white/5 flex-shrink-0"><button onClick={onSave} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors">Save Changes</button></div>
      </div>
    </div>
  );
}

function AppGated() {
  const [entered, setEntered] = useState(false);
  if (!entered && !getTraderToken()) {
    return <TokenEntry onSubmit={(admin, trader) => { setTokens({ adminToken: admin || undefined, traderToken: trader }); setEntered(true); }} />;
  }
  return <App />;
}

const DEFAULT_BALANCES = { mainBalance: 0, botBalance: 0, activeTradeBalance: 0, totalPnl: 0, totalPnlPct: 0 };

function App() {
  const [status, setStatus] = useState({ isRunning: false, currentRegime: 'uncertain', symbol: 'BTC/USDT', timeframe: '15m' });
  const [performance, setPerformance] = useState<any>({});
  const [regimeReasoning, setRegimeReasoning] = useState('');
  const [currentPrice, setCurrentPrice] = useState(0);
  const [trades, setTrades] = useState<any[]>([]);
  const [activeMode, setActiveMode] = useState('moderate');
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<any>({ symbol: 'BTC/USDT', timeframe: '15m', apiKey: '', apiSecret: '', apiPassword: '', testnet: 'true', aiStrategySwitching: 'false', aiSignalGeneration: 'false', aiSentimentAnalysis: 'false', exchange: 'coingecko', strategy: 'regime', shotgunTimeBefore: '0.5', shotgunTimeAfter: '10', altChaserPercentage: '1', chasingDragonsLeverage: '7', chasingDragonsStopLoss: '6', baseUrl: '', wsUrl: '', apiProviders: { binance: true, bybit: true, okx: true, kraken: true, coinbase: true }, systemJsonConfig: '{}' });
  const [riskConfigs, setRiskConfigs] = useState<Record<string, any>>({});
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [backtestTrades, setBacktestTrades] = useState<any[]>([]);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [balances, setBalances] = useState<typeof DEFAULT_BALANCES>(DEFAULT_BALANCES);
  const [showFreqtrade, setShowFreqtrade] = useState(false);
  const [showMlDashboard, setShowMlDashboard] = useState(false);
  const [marketData, setMarketData] = useState<any>(null);
  const [isRefreshingMarket, setIsRefreshingMarket] = useState(false);
  const [indicatorToggles, setIndicatorToggles] = useState<IndicatorToggles>({ ema9: false, ema21: false, ema50: false, vwap: false, bb: false });
  const [showBacktestUI, setShowBacktestUI] = useState(false);
  const [openPositions, setOpenPositions] = useState<any[]>([]);
  const [backtestDates, setBacktestDates] = useState({ start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], end: new Date().toISOString().split('T')[0] });
  const [backtestRegimeChanges, setBacktestRegimeChanges] = useState<any[]>([]);
  const [liveRegimeChanges, setLiveRegimeChanges] = useState<any[]>([]);
  const [lastCallTime, setLastCallTime] = useState(0);
  const [signalStatus, setSignalStatus] = useState<any>(null);
  const [closedTrades, setClosedTrades] = useState<any[]>([]);
  const [shadowTrades, setShadowTrades] = useState<any[]>([]);
  const [botTrades, setBotTrades] = useState<any[]>([]);
  const [botBalanceFlash, setBotBalanceFlash] = useState(false);
  const [tradeFilter, setTradeFilter] = useState('');
  const [showSignalMarkers, setShowSignalMarkers] = useState(true);
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);
  const [modeVisibility, setModeVisibility] = useState<Record<string, boolean>>({ ultra_conservative: true, conservative: true, moderate: true, aggressive: true, degen: true, ai_enhanced: true });
  const [signals, setSignals] = useState<any[]>([]);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candleDataRef = useRef<any[]>([]);
  const lastBalancesRef = useRef(DEFAULT_BALANCES);
  useEffect(() => {}, []);

  const updateBalances = useCallback((data: Partial<typeof DEFAULT_BALANCES>) => setBalances(prev => ({ ...DEFAULT_BALANCES, ...prev, ...data })), []);
  const mark = () => setLastCallTime(Date.now());
  const fetchStatus = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/status`); if (r.ok && r.data) setStatus(r.data); }, []);
  const fetchPerformance = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/performance`); if (r.ok && r.data) setPerformance(r.data); }, []);
  const fetchTrades = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/trades?limit=10`); if (r.ok && r.data) setTrades(r.data); }, []);
  const fetchClosedTrades = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/shadow-trades/closed?limit=100`); if (r.ok && r.data) setClosedTrades(Array.isArray(r.data) ? r.data : (r.data.trades || [])); }, []);
  const fetchShadowTrades = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/shadow-trades/all`); if (r.ok && r.data) setShadowTrades(Array.isArray(r.data) ? r.data : (r.data.trades || [])); }, []);
  const fetchBotTrades = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/trades/closed?limit=100`, { headers: { 'x-api-token': adminToken() } }); if (r.ok && r.data) setBotTrades(Array.isArray(r.data) ? r.data : []); }, []);
  const fetchSettings = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/settings`, { headers: { 'x-api-token': adminToken() } }); if (r.ok && r.data) setSettings((p: any) => ({ ...p, ...r.data })); }, []);
  const fetchRiskConfigs = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/risk-configs`, { headers: { 'x-api-token': adminToken() } }); if (r.ok && r.data) setRiskConfigs(r.data); }, []);
  const fetchBalances = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/balances`); if (r.ok && r.data) updateBalances(r.data); }, [updateBalances]);
  const fetchOpenPositions = useCallback(async () => { mark(); const r = await safeFetch(`${APP_URL}/api/positions/open`); if (r.ok && r.data) setOpenPositions(r.data); }, []);
  const fetchMarketData = useCallback(async () => { const r = await safeFetch(`${APP_URL}/api/market/data`); if (r.ok && r.data) setMarketData(r.data); }, []);
  const fetchMarketNews = useCallback(async () => { await safeFetch(`${APP_URL}/api/market/news`); }, []);
  const fetchSignals = useCallback(async () => { mark(); await safeFetch(`${APP_URL}/api/signals?limit=500`); }, []);

  const { isDataPassing, lastMessageTimeRef } = useTradingWebSocket({
    onStatus: (data) => setStatus((p: any) => ({ ...p, ...data })),
    onRegime: (data) => { setStatus((p: any) => ({ ...p, currentRegime: data.regime })); setRegimeReasoning(data.reasoning || ''); setLiveRegimeChanges(prev => [...prev, { time: Date.now(), regime: data.regime }]); },
    onPerformance: (data) => setPerformance(data),
    onCandle: (c: any) => { if (seriesRef.current && !showBacktestUI && c) { setCurrentPrice(c.close); const time = Math.floor(Number(c.time) / 1000); if (!isNaN(time) && time > 0) { const idx = candleDataRef.current.findIndex(cd => Number(cd.time) === time); if (idx >= 0) { seriesRef.current.update({ time: time as any, open: c.open, high: c.high, low: c.low, close: c.close }); } else { candleDataRef.current.push({ time, open: c.open, high: c.high, low: c.low, close: c.close }); seriesRef.current.update({ time: time as any, open: c.open, high: c.high, low: c.low, close: c.close }); } } } },
    onSignal: () => fetchTrades(),
    onAiModeSwitch: (mode) => setActiveMode(mode),
    onBalances: (data) => updateBalances(data),
    onSignalStatus: (data) => { setSignalStatus(data); mark(); fetchClosedTrades(); fetchTrades(); },
    onSignalRecord: (data) => { setSignals(prev => [data, ...prev].slice(0, 500)); fetchClosedTrades(); fetchTrades(); fetchShadowTrades(); },
  });

  useEffect(() => {
    fetchStatus(); fetchPerformance(); fetchTrades(); fetchClosedTrades(); fetchShadowTrades(); fetchSettings(); fetchRiskConfigs(); fetchBalances(); fetchOpenPositions(); fetchMarketData(); fetchMarketNews(); fetchSignals(); fetchBotTrades();
    const interval = setInterval(() => { fetchOpenPositions(); fetchBalances(); if (lastBalancesRef.current.botBalance !== balances.botBalance) { setBotBalanceFlash(true); setTimeout(() => setBotBalanceFlash(false), 600); } lastBalancesRef.current = balances; }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Backtest auto-run effect (preserved from original) ---
  const runBacktest = useCallback(async (startTime?: number, endTime?: number) => {
    if (!riskConfigs[activeMode]) { alert('Risk configuration not loaded yet. Please wait...'); return; }
    setIsBacktesting(true);
    try { mark(); const payload = { mode: activeMode, config: riskConfigs[activeMode], startTime: startTime || Date.now() - 30 * 24 * 60 * 60 * 1000, endTime: endTime || Date.now() }; const res = await fetch(`${APP_URL}/api/backtest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': adminToken() }, body: JSON.stringify(payload) }); if (!res.ok) throw new Error(`Backtest API error ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`); const data = await res.json();
      if (data.trades && data.candles) { setBacktestTrades(data.trades); setBacktestRegimeChanges(data.regimeChanges || []); if (seriesRef.current && Array.isArray(data.candles)) { const merged = [...candleDataRef.current, ...data.candles]; const map = new Map(); merged.forEach(c => map.set(c.time, c)); const unique = Array.from(map.values()).sort((a: any, b: any) => a.time - b.time); candleDataRef.current = unique; seriesRef.current.setData(unique.map((c: any) => ({ time: Math.floor(Number(c.time) / 1000) as any, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) })).filter((c: any) => !isNaN(c.time)).sort((a: any, b: any) => a.time - b.time)); } } else if (Array.isArray(data)) { setBacktestTrades(data); } else if (data.error) { throw new Error(data.error); }
    } catch (e) { debug.error('[Backtest] Failed:', e); alert(`Backtest failed: ${e instanceof Error ? e.message : String(e)}`); } finally { setIsBacktesting(false); }
  }, [riskConfigs, activeMode]);

  useEffect(() => { if (showConfigModal && !showBacktestUI) { runBacktest(); } else if (!showConfigModal && !showBacktestUI) { setBacktestTrades([]); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConfigModal, activeMode, riskConfigs[activeMode], showBacktestUI]);

  const saveRiskConfigs = useCallback(async () => { try { mark(); await fetch(`${APP_URL}/api/risk-configs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': adminToken() }, body: JSON.stringify(riskConfigs) }); setShowConfigModal(false); } catch (e) { debug.error(e); } }, [riskConfigs]);
  const resetRiskConfigs = useCallback(async () => { try { mark(); const res = await fetch(`${APP_URL}/api/risk-configs/reset`, { method: 'POST', headers: { 'x-api-token': adminToken() } }); const data = await res.json(); if (data.success) setRiskConfigs(data.configs); } catch (e) { debug.error(e); } }, []);
  const getAiRecommendations = useCallback(async () => { try { mark(); const res = await fetch(`${APP_URL}/api/risk-configs/ai-recommend`, { method: 'POST', headers: { 'x-api-token': adminToken() } }); if (!res.ok) throw new Error(`API error: ${res.status}`); const data = await res.json(); if (data.success && data.configs) setRiskConfigs(prev => { const m = { ...prev }; for (const [mode, cfg] of Object.entries(data.configs)) m[mode] = { ...(m[mode] || {}), ...(cfg as any) }; return m; }); } catch (e) { debug.error('[AI] Recommend failed:', e); alert('AI recommendation failed. Using fallback logic.'); } }, []);
  const saveSettings = useCallback(async () => { try { mark(); await fetch(`${APP_URL}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': adminToken() }, body: JSON.stringify(settings) }); setShowSettings(false); fetchStatus(); } catch (e) { debug.error(e); } }, [settings, fetchStatus]);
  const toggleEngine = useCallback(async () => { try { mark(); const ep = status.isRunning ? '/api/stop' : '/api/start'; const r = await safeFetch(`${APP_URL}${ep}`, { method: 'POST', headers: { 'x-api-token': adminToken() } }); if (r.ok) fetchStatus(); else debug.error('Engine toggle failed:', r.error); } catch (e) { debug.error(e); } }, [status.isRunning, fetchStatus]);
  const manualTrade = useCallback(async (side: 'buy' | 'sell') => { if (currentPrice === 0) { alert('No current price available. Wait for market data to load.'); return; } const sym = status.symbol || 'BTC/USDT'; const lev = riskConfigs[activeMode]?.leverage || 1; const ps = riskConfigs[activeMode]?.positionSize || 0.02; const amt = (balances.mainBalance * ps) / currentPrice; if (!window.confirm(`Confirm ${side.toUpperCase()} Trade\n  Symbol: ${sym}\n  Price: $${currentPrice.toFixed(2)}\n  Mode: ${activeMode.replace('_', ' ')}\n  Leverage: ${lev}x\n  Est. Size: ${amt.toFixed(4)} BTC\n  Est. Value: $${(amt * currentPrice).toFixed(2)}\n\nThis trade will be executed on the shadow portfolio.\nContinue?`)) return; if (!status.isRunning) { try { mark(); await fetch(`${APP_URL}/api/start`, { method: 'POST', headers: { 'x-api-token': adminToken() } }); setStatus(p => ({ ...p, isRunning: true })); } catch (e) { debug.error('Failed to auto-start engine for manual trade:', e); } } try { mark(); const resp = await fetch(`${APP_URL}/api/manual-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ side, symbol: status.symbol, price: currentPrice, stopLoss: side === 'buy' ? currentPrice * 0.98 : currentPrice * 1.02, takeProfit: side === 'buy' ? currentPrice * 1.02 : currentPrice * 0.98 }) }); const result = await resp.json(); if (!result.success) alert(result.error); fetchTrades(); fetchOpenPositions(); } catch (e) { debug.error(e); alert('Failed to execute trade'); } }, [currentPrice, status, riskConfigs, activeMode, balances.mainBalance, fetchTrades, fetchOpenPositions]);
  const changeTimeframe = useCallback(async (tf: string) => { try { mark(); const res = await fetch(`${APP_URL}/api/timeframe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ timeframe: tf }) }); if (!res.ok) debug.warn('[Timeframe] API rejected:', await res.text()); setStatus(p => ({ ...p, timeframe: tf })); } catch (e) { debug.error(e); } }, []);
  const changeSymbol = useCallback(async (sym: string) => { try { mark(); const res = await fetch(`${APP_URL}/api/symbol`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ symbol: sym }) }); if (!res.ok) debug.warn('[Symbol] API rejected:', await res.text()); setStatus(p => ({ ...p, symbol: sym })); setSettings((p: any) => ({ ...p, symbol: sym })); } catch (e) { debug.error(e); } }, []);
  const killBot = useCallback(async () => { if (confirm('Are you sure you want to KILL the bot? This will stop the engine and close all positions.')) { try { mark(); await safeFetch(`${APP_URL}/api/kill`, { method: 'POST', headers: { 'x-api-token': adminToken() } }); fetchStatus(); fetchTrades(); fetchPerformance(); } catch (e) { debug.error('Failed to kill bot:', e); } } }, [fetchStatus, fetchTrades, fetchPerformance]);
  const changeActiveMode = useCallback(async (mode: string) => { setActiveMode(mode); try { await safeFetch(`${APP_URL}/api/active-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ mode }) }); } catch (e) { debug.error('Failed to change active mode:', e); } }, []);
  const allocateBalance = useCallback(async (amount: number) => { try { mark(); const resp = await fetch(`${APP_URL}/api/balances/allocate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ amount }) }); const data = await resp.json(); if (!resp.ok) { alert(data.error || `Server error: ${resp.status}`); return; } if (data.balances) updateBalances(data.balances); else if (data.success) { const br = await fetch(`${APP_URL}/api/balances`, { headers: { 'x-api-token': traderToken() } }); if (br.ok) updateBalances(await br.json()); } if (data.error) alert(data.error); } catch (e) { debug.error('Failed to allocate balance:', e); alert('Failed to allocate balance. Check console for details.'); } }, [updateBalances]);
  const withdrawBalance = useCallback(async (amount: number) => { try { mark(); const resp = await fetch(`${APP_URL}/api/balances/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ amount }) }); const data = await resp.json(); if (data.balances) updateBalances(data.balances); if (data.error) alert(data.error); } catch (e) { debug.error('Failed to withdraw balance:', e); } }, [updateBalances]);
  const halfBalance = useCallback(async () => { try { mark(); const r = await fetch(`${APP_URL}/api/balances/half`, { method: 'POST', headers: { 'x-api-token': traderToken() } }); const d = await r.json(); if (d.balances) updateBalances(d.balances); } catch (e) { debug.error('Failed to half balance:', e); } }, [updateBalances]);
  const doubleBalance = useCallback(async () => { try { mark(); const r = await fetch(`${APP_URL}/api/balances/double`, { method: 'POST', headers: { 'x-api-token': traderToken() } }); const d = await r.json(); if (d.balances) updateBalances(d.balances); if (d.error) alert(d.error); } catch (e) { debug.error('Failed to double balance:', e); } }, [updateBalances]);
  const closePosition = useCallback(async (tradeId: string) => { try { mark(); const r = await safeFetch(`${APP_URL}/api/positions/close`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ tradeId, currentPrice }) }); if (r.ok && r.data?.success) { fetchOpenPositions(); fetchTrades(); fetchBalances(); } } catch (e) { debug.error('Failed to close position:', e); } }, [currentPrice, fetchOpenPositions, fetchTrades, fetchBalances]);
  const updatePositionParams = useCallback(async (tradeId: string, stopLoss: number, takeProfit: number) => { try { mark(); const r = await safeFetch(`${APP_URL}/api/positions/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ tradeId, stopLoss, takeProfit }) }); if (r.ok && r.data?.success) fetchOpenPositions(); } catch (e) { debug.error('Failed to update position params:', e); } }, [fetchOpenPositions]);
  const refreshMarketData = useCallback(async () => { setIsRefreshingMarket(true); try { mark(); await safeFetch(`${APP_URL}/api/market/refresh`, { method: 'POST', headers: { 'x-api-token': traderToken() } }); await fetchMarketData(); await fetchMarketNews(); } catch (e) { debug.error('Failed to refresh market data:', e); } finally { setIsRefreshingMarket(false); } }, [fetchMarketData, fetchMarketNews]);

  return (
    <div className="min-h-screen bg-[#121212] text-gray-100 p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2"><h1 className="text-2xl font-bold tracking-tight">Adaptive Trading System</h1></div>
            <div className="flex items-center gap-2 mt-1"><span className="text-gray-500 text-sm">• Multi-Regime Shadow Trading</span></div>
            <div className="flex items-center gap-1.5 mt-2">{['BTC/USDT', 'ETH/USDT', 'SOL/USDT'].map(sym => <button key={sym} onClick={() => changeSymbol(sym)} className={`px-3 py-1 text-xs rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none ${status.symbol === sym ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'bg-white/5 hover:bg-white/10 text-gray-400 border border-transparent'}`}>{sym}</button>)}</div>
          </div>
          <div className="flex items-center gap-4">
            <StatusLight isLive={true} apiName={(status as any).exchange ? (status as any).exchange.charAt(0).toUpperCase() + (status as any).exchange.slice(1) : "CoinMarketCap"} isDataPassing={isDataPassing} lastCallTime={lastCallTime} />
            <div className="flex flex-col items-end gap-1">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${getRegimeColor(status.currentRegime)}`}>{getRegimeIcon(status.currentRegime)}
                <select value={status.currentRegime} aria-label="Market regime selection" onChange={async (e) => { const val = e.target.value; await safeFetch('/api/regime/manual', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': traderToken() }, body: JSON.stringify({ regime: val === 'auto' ? null : val }) }); if (val !== 'auto') { setStatus(p => ({ ...p, currentRegime: val })); setRegimeReasoning('Manually set by user'); } }} className="bg-[#1e1e1e] text-gray-300 text-sm font-medium uppercase tracking-wider cursor-pointer focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none">
                  <option value="auto" className="bg-black text-white">AUTO</option><option value="strongbull" className="bg-black text-white">STRONG BULL</option><option value="weakbull" className="bg-black text-white">WEAK BULL</option><option value="bear" className="bg-black text-white">BEAR</option><option value="sideways" className="bg-black text-white">SIDEWAYS</option><option value="uncertain" className="bg-black text-white">UNCERTAIN</option>
                </select>
              </div>
              {regimeReasoning && <div className="flex items-center gap-1 text-[10px] text-gray-500 italic max-w-[200px] truncate"><Activity size={10} /><span>{regimeReasoning}</span></div>}
            </div>
            <SignalConfidencePanel signalStatus={signalStatus} currentRegime={status.currentRegime} />
            <EngineControls isRunning={status.isRunning} currentPrice={currentPrice} balances={balances} riskConfigs={riskConfigs} activeMode={activeMode} symbol={status.symbol} onToggleEngine={toggleEngine} onManualTrade={manualTrade} onKillBot={killBot} onOpenSettings={() => setShowSettings(true)} onOpenFreqtrade={() => setShowFreqtrade(true)} />
            <button onClick={() => setShowMlDashboard(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/20 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none" aria-label="Open ML monitoring dashboard"><Brain className="w-4 h-4" />ML Dashboard</button>
          </div>
        </div>
        {/* Market Overview Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center"><p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1">Market Cap</p><p className="text-sm font-mono text-white">{marketData ? `$${(marketData.market_cap / 1e12).toFixed(2)}T` : '---'}</p></div>
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center"><p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1">24h Volume</p><p className="text-sm font-mono text-white">{marketData ? `$${(marketData.total_volume / 1e9).toFixed(2)}B` : '---'}</p></div>
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center"><p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1">BTC Dominance</p><p className="text-sm font-mono text-white">{marketData ? `${marketData.btc_dominance.toFixed(1)}%` : '---'}</p></div>
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center"><div className="flex justify-between items-center mb-1"><p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Fear & Greed</p>{marketData && <span className={`text-[8px] font-bold px-1 rounded ${marketData.fear_greed_index > 70 ? 'bg-emerald-500/20 text-emerald-400' : marketData.fear_greed_index < 30 ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>{marketData.fear_greed_value}</span>}</div><p className="text-sm font-mono text-white">{marketData ? marketData.fear_greed_index : '---'}</p></div>
          <div className="col-span-2 md:col-span-4 lg:col-span-1 flex items-center gap-2"><button onClick={refreshMarketData} disabled={isRefreshingMarket} className="flex-1 h-full bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-xl text-xs font-bold flex items-center justify-center gap-2 py-3 lg:py-0 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"><Activity className={`w-4 h-4 ${isRefreshingMarket ? 'animate-spin' : ''}`} />{isRefreshingMarket ? 'Refreshing...' : 'Refresh Market Data'}</button></div>
        </div>
        {/* Main Content Grid */}
        <div className={`grid grid-cols-1 lg:grid-cols-3 gap-6 transition-colors duration-300 ${showBacktestUI ? 'bg-amber-950/5' : ''}`}>
          <ChartPanel status={status} trades={trades} backtestTrades={backtestTrades} backtestRegimeChanges={backtestRegimeChanges} liveRegimeChanges={liveRegimeChanges} shadowTrades={shadowTrades} performance={performance} activeMode={activeMode} showBacktestUI={showBacktestUI} indicatorToggles={indicatorToggles} onIndicatorToggle={(key) => setIndicatorToggles(p => ({ ...p, [key]: !p[key] }))} onToggleBacktest={() => setShowBacktestUI(!showBacktestUI)} onResetZoom={() => chartRef.current?.timeScale().fitContent()} onChangeTimeframe={changeTimeframe} onRunBacktest={(s, e) => runBacktest(s, e)} isBacktesting={isBacktesting} backtestDates={backtestDates} onBacktestDatesChange={setBacktestDates} showSignalMarkers={showSignalMarkers} showTradeMarkers={showTradeMarkers} onToggleSignalMarkers={() => setShowSignalMarkers(!showSignalMarkers)} onToggleTradeMarkers={() => setShowTradeMarkers(!showTradeMarkers)} modeVisibility={modeVisibility} onToggleModeVisibility={(mode) => setModeVisibility(prev => ({ ...prev, [mode]: !prev[mode] }))} onChangeActiveMode={changeActiveMode} chartRef={chartRef} seriesRef={seriesRef} onCurrentPriceChange={setCurrentPrice} candleDataRef={candleDataRef} />
          <div className="space-y-6">
            <BalanceControls balances={balances} showBacktestUI={showBacktestUI} botBalanceFlash={botBalanceFlash} onKillBot={killBot} onAllocate={allocateBalance} onWithdraw={withdrawBalance} onHalf={halfBalance} onDouble={doubleBalance} />
            <RiskConfigModal activeMode={activeMode} riskConfigs={riskConfigs} showBacktestUI={showBacktestUI} isBacktesting={isBacktesting} backtestTrades={backtestTrades} performance={performance} showConfigModal={showConfigModal} onToggleConfigModal={() => setShowConfigModal(!showConfigModal)} onRiskConfigsChange={setRiskConfigs} onSaveRiskConfigs={saveRiskConfigs} onResetRiskConfigs={resetRiskConfigs} onGetAiRecommendations={getAiRecommendations} onChangeActiveMode={changeActiveMode} />
            <TradeTables showBacktestUI={showBacktestUI} openPositions={openPositions} botTrades={botTrades} closedTrades={closedTrades} backtestTrades={backtestTrades} currentPrice={currentPrice} tradeFilter={tradeFilter} onTradeFilterChange={setTradeFilter} modeVisibility={modeVisibility} onClosePosition={closePosition} onUpdatePositionParams={updatePositionParams} />
          </div>
        </div>
      </div>
      {showSettings && <SettingsModal settings={settings} setSettings={setSettings} onClose={() => setShowSettings(false)} onSave={saveSettings} />}
      {showFreqtrade && (<div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowFreqtrade(false)}><div className="bg-[#1e1e1e] border border-white/10 rounded-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}><div className="flex justify-between items-center p-4 border-b border-white/10"><h2 className="text-xl font-bold flex items-center gap-2"><DatabaseIcon className="w-5 h-5 text-indigo-400" />Freqtrade Integration</h2><button onClick={() => setShowFreqtrade(false)} className="text-gray-400 hover:text-white focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none" aria-label="Close Freqtrade panel"><X className="w-5 h-5" /></button></div><div className="p-4"><FreqtradePanel /></div></div></div>)}
      {showMlDashboard && (<div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowMlDashboard(false)}><div className="bg-[#1e1e1e] border border-white/10 rounded-xl w-full max-w-5xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}><div className="flex justify-between items-center p-4 border-b border-white/10"><h2 className="text-xl font-bold flex items-center gap-2"><Brain className="w-5 h-5 text-purple-400" />ML Monitoring</h2><button onClick={() => setShowMlDashboard(false)} className="text-gray-400 hover:text-white focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none" aria-label="Close ML dashboard"><X className="w-5 h-5" /></button></div><div className="p-4"><MLDashboard symbol={status.symbol} /></div></div></div>)}
    </div>
  );
}

export default AppGated;
