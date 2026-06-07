import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Activity, AlertTriangle, CheckCircle, Clock, Database, Download, Loader2, Play, XCircle, RefreshCw, TrendingUp, TrendingDown, Minus, AlertCircle, Settings, ChevronRight } from 'lucide-react';

// Types
interface FreqtradeJob {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  started?: number;
  completed?: number;
  error?: string;
  progress?: string;
}

interface AvailablePair {
  exchange: string;
  pair: string;
  timeframe: string;
}

interface BacktestResult {
  [key: string]: any;
}

interface FreqtradeInfo {
  version?: string;
  strategies?: string[];
  exchanges?: string[];
}

// Safe fetch with auth + dedup + 5s LRU cache
const inflightRequests = new Map<string, Promise<any>>();
const responseCache = new Map<string, { ts: number; data: any }>();
const CACHE_TTL = 5000;
const MAX_CACHE_ENTRIES = 100;

function getCached(url: string) {
  const entry = responseCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= CACHE_TTL) {
    responseCache.delete(url);
    return undefined;
  }
  responseCache.delete(url);
  responseCache.set(url, entry);
  return entry.data;
}

function setCached(url: string, data: any) {
  responseCache.set(url, { ts: Date.now(), data });
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const key = responseCache.keys().next().value;
    if (key !== undefined) responseCache.delete(key);
  }
}

const APP_URL = '';
function getToken(): string {
  try {
    // @ts-ignore
    const token = (import.meta as any).env?.VITE_ADMIN_TOKEN || '';
    return token;
  } catch { return ''; }
}

async function safeFetch(url: string, options?: RequestInit): Promise<{ ok: boolean; data?: any; error?: string }> {
  const method = options?.method?.toUpperCase() || 'GET';

  if (method === 'GET') {
    const cached = getCached(url);
    if (cached !== undefined) return { ok: true, data: cached };

    const inflight = inflightRequests.get(url);
    if (inflight) return inflight;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> || {}),
  };
  const token = getToken();
  if (token && !token.includes('PLACEHOLDER')) {
    headers['x-api-token'] = token;
  }

  const request = (async () => {
    try {
      const res = await fetch(url, { ...options, headers });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 100)}` };
      try {
        const data = JSON.parse(text);
        if (method === 'GET') setCached(url, data);
        return { ok: true, data };
      } catch {
        return { ok: true, data: text };
      }
    } catch (e: any) {
      return { ok: false, error: e.message || 'Network error' };
    } finally {
      if (method === 'GET') inflightRequests.delete(url);
    }
  })();

  if (method === 'GET') inflightRequests.set(url, request);
  return request;
}

function invalidateCache(prefix: string) {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}

// Helper: format timestamp
function fmt(ts: number | undefined) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString();
}

// Helper: status pill colors
function statusColor(status: string) {
  switch (status) {
    case 'completed': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    case 'running': case 'pending': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    case 'failed': return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'cancelled': return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    default: return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

export default function FreqtradePanel() {
  const [activeTab, setActiveTab] = useState<'data' | 'backtest' | 'validate'>('data');

  // Shared state
  const [jobs, setJobs] = useState<FreqtradeJob[]>([]);
  const [info, setInfo] = useState<FreqtradeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Data tab state
  const [availablePairs, setAvailablePairs] = useState<AvailablePair[]>([]);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});

  // Backtest tab state
  const [btStrategy, setBtStrategy] = useState('');
  const [btTimerangeStart, setBtTimerangeStart] = useState(() => {
    const d = new Date(Date.now() - 30 * 86400000);
    return d.toISOString().split('T')[0];
  });
  const [btTimerangeEnd, setBtTimerangeEnd] = useState(() => new Date().toISOString().split('T')[0]);
  const [btWallet, setBtWallet] = useState('10000');
  const [btResult, setBtResult] = useState<BacktestResult | null>(null);
  const [btLoading, setBtLoading] = useState(false);

  // Validate tab state
  const [valStrategy, setValStrategy] = useState('');
  const [valTimerangeStart, setValTimerangeStart] = useState(() => {
    const d = new Date(Date.now() - 30 * 86400000);
    return d.toISOString().split('T')[0];
  });
  const [valTimerangeEnd, setValTimerangeEnd] = useState(() => new Date().toISOString().split('T')[0]);
  const [valResult, setValResult] = useState<{ inHouse: any; freqtrade: any; delta: any; passed: boolean } | null>(null);
  const [valLoading, setValLoading] = useState(false);

  // Fetch info (strategies, version)
  const fetchInfo = useCallback(async () => {
    const res = await safeFetch(`${APP_URL}/api/freqtrade/info`);
    if (res.ok && res.data) {
      setInfo(res.data);
      if (res.data.strategies?.length) {
        if (!btStrategy) setBtStrategy(res.data.strategies[0]);
        if (!valStrategy) setValStrategy(res.data.strategies[0]);
      }
    }
  }, [btStrategy, valStrategy]);

  // Fetch available pairs
  const fetchPairs = useCallback(async () => {
    const res = await safeFetch(`${APP_URL}/api/freqtrade/pairs`);
    if (res.ok && res.data) {
      const pairs: AvailablePair[] = Array.isArray(res.data) ? res.data : [];
      setAvailablePairs(pairs);
    }
  }, []);

  // Fetch jobs
  const fetchJobs = useCallback(async () => {
    const res = await safeFetch(`${APP_URL}/api/freqtrade/jobs`);
    if (res.ok && res.data) {
      setJobs(Array.isArray(res.data) ? res.data : []);
    }
  }, []);

  // Initial data load
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await Promise.all([fetchInfo(), fetchPairs(), fetchJobs()]);
      } catch (e: any) {
        setError(e.message || 'Failed to load data');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Poll jobs every 2s if any are in-flight
  useEffect(() => {
    const hasInFlight = jobs.some(j => j.status === 'pending' || j.status === 'running');
    if (hasInFlight && !pollRef.current) {
      pollRef.current = setInterval(() => {
        fetchJobs();
      }, 2000);
    } else if (!hasInFlight && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobs, fetchJobs]);

  // --- Data tab ---
  const handleDownload = async (exchange: string, pair: string, timeframe: string) => {
    const key = `${exchange}:${pair}:${timeframe}`;
    setDownloading(prev => ({ ...prev, [key]: true }));
    try {
      const res = await safeFetch(`${APP_URL}/api/freqtrade/download-data`, {
        method: 'POST',
        body: JSON.stringify({
          exchange,
          pairs: [pair],
          timeframes: [timeframe],
          timerange: `${btTimerangeStart.replace(/-/g, '')}-${btTimerangeEnd.replace(/-/g, '')}`,
        }),
      });
      if (!res.ok) {
        alert(`Download failed: ${res.error}`);
      }
      // Invalidate cache so next fetch gets fresh data
      invalidateCache(`${APP_URL}/api/freqtrade/pairs`);
      invalidateCache(`${APP_URL}/api/freqtrade/jobs`);
      await fetchJobs();
    } catch (e: any) {
      alert(`Download error: ${e.message}`);
    } finally {
      setDownloading(prev => ({ ...prev, [key]: false }));
    }
  };

  // --- Backtest tab ---
  const handleRunBacktest = async () => {
    if (!btStrategy) { alert('Please select a strategy'); return; }
    setBtLoading(true);
    setBtResult(null);
    try {
      const timerange = `${btTimerangeStart.replace(/-/g, '')}-${btTimerangeEnd.replace(/-/g, '')}`;
      const res = await safeFetch(`${APP_URL}/api/freqtrade/backtest`, {
        method: 'POST',
        body: JSON.stringify({
          strategy: btStrategy,
          timerange,
          dryRunWallet: parseFloat(btWallet) || 10000,
        }),
      });
      if (res.ok && res.data) {
        setBtResult(res.data);
        invalidateCache(`${APP_URL}/api/freqtrade/jobs`);
        await fetchJobs();
      } else {
        alert(`Backtest failed: ${res.error}`);
      }
    } catch (e: any) {
      alert(`Backtest error: ${e.message}`);
    } finally {
      setBtLoading(false);
    }
  };

  // --- Validate tab ---
  const handleValidate = async () => {
    if (!valStrategy) { alert('Please select a strategy'); return; }
    setValLoading(true);
    setValResult(null);
    try {
      const timerange = `${valTimerangeStart.replace(/-/g, '')}-${valTimerangeEnd.replace(/-/g, '')}`;
      const res = await safeFetch(`${APP_URL}/api/freqtrade/validate`, {
        method: 'POST',
        body: JSON.stringify({
          strategy: valStrategy,
          timerange,
          dryRunWallet: 10000,
        }),
      });
      if (res.ok && res.data) {
        setValResult(res.data);
      } else {
        alert(`Validation failed: ${res.error}`);
      }
    } catch (e: any) {
      alert(`Validation error: ${e.message}`);
    } finally {
      setValLoading(false);
    }
  };

  // --- Render helpers ---
  const metricRow = (label: string, inHouseVal: any, ftVal: any, delta: any, passed: boolean) => {
    const fmtNum = (v: any) => {
      if (v === undefined || v === null) return '--';
      if (typeof v === 'number') return v.toFixed(4);
      return String(v);
    };
    return (
      <tr key={label} className="border-b border-white/5">
        <td className="py-2 px-3 text-sm text-gray-300 font-medium">{label}</td>
        <td className="py-2 px-3 text-sm font-mono text-white">{fmtNum(inHouseVal)}</td>
        <td className="py-2 px-3 text-sm font-mono text-white">{fmtNum(ftVal)}</td>
        <td className="py-2 px-3 text-sm font-mono">{fmtNum(delta)}</td>
        <td className="py-2 px-3">
          {passed
            ? <CheckCircle className="w-4 h-4 text-emerald-400" />
            : <XCircle className="w-4 h-4 text-red-400" />}
        </td>
      </tr>
    );
  };

  const inFlightJobs = jobs.filter(j => j.status === 'pending' || j.status === 'running');

  if (loading) {
    return (
      <div className="bg-[#1e1e1e] rounded-xl border border-white/10 p-8">
        <div className="flex items-center justify-center gap-3 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading Freqtrade data...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#1e1e1e] rounded-xl border border-white/10 overflow-hidden">
      {/* Panel Header */}
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-indigo-400" />
          <h2 className="text-lg font-bold">Freqtrade Sidecar</h2>
          {info?.version && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
              v{info.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {inFlightJobs.length > 0 && (
            <div className="flex items-center gap-1 text-xs text-blue-400 bg-blue-500/10 px-2 py-1 rounded-full border border-blue-500/20">
              <Loader2 className="w-3 h-3 animate-spin" />
              {inFlightJobs.length} running
            </div>
          )}
          <button
            onClick={() => { fetchInfo(); fetchPairs(); fetchJobs(); }}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/10">
        {(['data', 'backtest', 'validate'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
              activeTab === tab
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/5'
                : 'border-transparent text-gray-400 hover:text-gray-300 hover:bg-white/5'
            }`}
          >
            <span className="capitalize">{tab}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="p-4">
        {error && (
          <div className="mb-4 flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-300">&times;</button>
          </div>
        )}

        {/* ---- DATA TAB ---- */}
        {activeTab === 'data' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                <Database className="w-4 h-4" />
                Available Data
              </h3>
              <span className="text-xs text-gray-500">{availablePairs.length} entries</span>
            </div>

            {availablePairs.length === 0 ? (
              <div className="text-center py-8 text-gray-500 text-sm">
                <Database className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No data available yet.</p>
                <p className="text-xs mt-1">Use the Download button to fetch data from an exchange.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-xs text-gray-500 uppercase tracking-wider">
                      <th className="text-left py-2 px-3 font-medium">Exchange</th>
                      <th className="text-left py-2 px-3 font-medium">Pair</th>
                      <th className="text-left py-2 px-3 font-medium">Timeframe</th>
                      <th className="text-right py-2 px-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {availablePairs.map((entry, i) => {
                      const dlKey = `${entry.exchange}:${entry.pair}:${entry.timeframe}`;
                      return (
                        <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                          <td className="py-2 px-3 font-mono text-xs text-gray-300">{entry.exchange}</td>
                          <td className="py-2 px-3 font-mono text-xs text-white">{entry.pair}</td>
                          <td className="py-2 px-3 font-mono text-xs text-gray-300">{entry.timeframe}</td>
                          <td className="py-2 px-3 text-right">
                            <button
                              onClick={() => handleDownload(entry.exchange, entry.pair, entry.timeframe)}
                              disabled={downloading[dlKey]}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
                            >
                              {downloading[dlKey] ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Download className="w-3 h-3" />
                              )}
                              {downloading[dlKey] ? 'Downloading...' : 'Download'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* In-flight jobs */}
            {inFlightJobs.length > 0 && (
              <div className="mt-4">
                <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
                  <Activity className="w-3 h-3" />
                  Active Jobs
                </h4>
                <div className="space-y-2">
                  {inFlightJobs.map(job => (
                    <div key={job.id} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2 border border-white/5">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                        <span className="text-xs font-mono text-gray-300">{job.type}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${statusColor(job.status)}`}>
                          {job.status}
                        </span>
                      </div>
                      <span className="text-[10px] text-gray-500">{job.progress || ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- BACKTEST TAB ---- */}
        {activeTab === 'backtest' && (
          <div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Strategy</label>
                <select
                  value={btStrategy}
                  onChange={e => setBtStrategy(e.target.value)}
                  className="w-full bg-[#121212] text-gray-300 border border-white/10 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none"
                >
                  {!info?.strategies?.length && <option value="">No strategies found</option>}
                  {info?.strategies?.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Dry-run Wallet (USDT)</label>
                <input
                  type="number"
                  value={btWallet}
                  onChange={e => setBtWallet(e.target.value)}
                  className="w-full bg-[#121212] text-white border border-white/10 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Start Date</label>
                <input
                  type="date"
                  value={btTimerangeStart}
                  onChange={e => setBtTimerangeStart(e.target.value)}
                  className="w-full bg-[#121212] text-white border border-white/10 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">End Date</label>
                <input
                  type="date"
                  value={btTimerangeEnd}
                  onChange={e => setBtTimerangeEnd(e.target.value)}
                  className="w-full bg-[#121212] text-white border border-white/10 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none"
                />
              </div>
            </div>
            <button
              onClick={handleRunBacktest}
              disabled={btLoading || !btStrategy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
            >
              {btLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {btLoading ? 'Running Backtest...' : 'Run Backtest'}
            </button>

            {/* Backtest Results */}
            {btResult && (
              <div className="mt-4 bg-white/5 rounded-lg border border-white/10 p-4">
                <h4 className="text-sm font-medium text-gray-300 mb-3">Backtest Results</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-xs text-gray-500 uppercase tracking-wider">
                        <th className="text-left py-2 px-3 font-medium">Metric</th>
                        <th className="text-right py-2 px-3 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(btResult).map(([key, val]) => (
                        <tr key={key} className="border-b border-white/5">
                          <td className="py-2 px-3 text-sm text-gray-300">{key}</td>
                          <td className="py-2 px-3 text-sm font-mono text-white text-right">
                            {typeof val === 'number' ? val.toFixed(4) : String(val)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- VALIDATE TAB ---- */}
        {activeTab === 'validate' && (
          <div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Strategy</label>
                <select
                  value={valStrategy}
                  onChange={e => setValStrategy(e.target.value)}
                  className="w-full bg-[#121212] text-gray-300 border border-white/10 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none"
                >
                  {!info?.strategies?.length && <option value="">No strategies found</option>}
                  {info?.strategies?.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div></div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Start Date</label>
                <input
                  type="date"
                  value={valTimerangeStart}
                  onChange={e => setValTimerangeStart(e.target.value)}
                  className="w-full bg-[#121212] text-white border border-white/10 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">End Date</label>
                <input
                  type="date"
                  value={valTimerangeEnd}
                  onChange={e => setValTimerangeEnd(e.target.value)}
                  className="w-full bg-[#121212] text-white border border-white/10 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none"
                />
              </div>
            </div>
            <button
              onClick={handleValidate}
              disabled={valLoading || !valStrategy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
            >
              {valLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              {valLoading ? 'Running Validation...' : 'Run Validation'}
            </button>

            {/* Validation Results */}
            {valResult && (
              <div className="mt-4 space-y-4">
                {/* Pass/Fail banner */}
                <div className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${
                  valResult.passed
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                }`}>
                  {valResult.passed ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  <span>{valResult.passed ? 'All metrics within tolerance' : 'Some metrics outside tolerance'}</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-xs text-gray-500 uppercase tracking-wider">
                        <th className="text-left py-2 px-3 font-medium">Metric</th>
                        <th className="text-right py-2 px-3 font-medium">In-House</th>
                        <th className="text-right py-2 px-3 font-medium">Freqtrade</th>
                        <th className="text-right py-2 px-3 font-medium">Delta</th>
                        <th className="text-center py-2 px-3 font-medium">Pass</th>
                      </tr>
                    </thead>
                    <tbody>
                      {valResult.inHouse && valResult.freqtrade && valResult.delta
                        ? Object.keys(valResult.inHouse).map(key =>
                            metricRow(
                              key,
                              valResult.inHouse[key],
                              valResult.freqtrade[key],
                              valResult.delta[key],
                              Math.abs(Number(valResult.delta[key]) || 0) < 0.05
                            )
                          )
                        : (
                          <tr>
                            <td colSpan={5} className="py-4 text-center text-gray-500 text-sm">
                              No metric data available
                            </td>
                          </tr>
                        )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent jobs summary */}
        {jobs.length > 0 && (
          <div className="mt-6 pt-4 border-t border-white/10">
            <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Recent Jobs
            </h4>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {jobs.slice(0, 20).map(job => (
                <div key={job.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      job.status === 'completed' ? 'bg-emerald-500' :
                      job.status === 'running' ? 'bg-blue-500 animate-pulse' :
                      job.status === 'failed' ? 'bg-red-500' : 'bg-gray-500'
                    }`} />
                    <span className="font-mono text-gray-300">{job.type}</span>
                    <span className={`text-[10px] px-1 py-0.5 rounded border ${statusColor(job.status)}`}>
                      {job.status}
                    </span>
                  </div>
                  <span className="text-gray-500">{job.started ? fmt(job.started) : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
