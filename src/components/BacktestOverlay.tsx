/**
 * BacktestOverlay — date-range form and /api/backtest call.
 *
 * Extracted from App() runBacktest logic (originally lines ~964-1061).
 * This component handles the backtest date form, runs the backtest API call,
 * and displays results. The actual chart overlay (candles + markers) is handled
 * by ChartPanel via the backtestTrades/backtestRegimeChanges props.
 *
 * Props: data in (activeMode, riskConfigs, isBacktesting, backtestTrades),
 * callbacks out (onBacktestResult with trades + regimeChanges + candles).
 */
import React, { useState, useCallback } from 'react';
import { Calendar, Play, Activity } from 'lucide-react';
import { APP_URL, adminToken, debug } from '../api/client';

interface BacktestOverlayProps {
  activeMode: string;
  riskConfigs: Record<string, any>;
  isBacktesting: boolean;
  backtestTrades: any[];
  showBacktestUI: boolean;
  backtestDates: { start: string; end: string };
  onBacktestDatesChange: (dates: { start: string; end: string }) => void;
  onBacktestResult: (trades: any[], regimeChanges: any[], candles: any[]) => void;
  setIsBacktesting: (v: boolean) => void;
}

export default function BacktestOverlay(props: BacktestOverlayProps) {
  const {
    activeMode, riskConfigs, isBacktesting, backtestTrades,
    showBacktestUI, backtestDates, onBacktestDatesChange,
    onBacktestResult, setIsBacktesting,
  } = props;

  const runBacktest = useCallback(async (startTime?: number, endTime?: number) => {
    if (!riskConfigs[activeMode]) {
      debug.warn('[Backtest] No risk config for mode:', activeMode);
      alert('Risk configuration not loaded yet. Please wait...');
      return;
    }
    setIsBacktesting(true);
    try {
      const payload = {
        mode: activeMode,
        config: riskConfigs[activeMode],
        startTime: startTime || Date.now() - 30 * 24 * 60 * 60 * 1000,
        endTime: endTime || Date.now(),
      };
      debug.log('[Backtest] Sending:', JSON.stringify(payload).slice(0, 200));
      const res = await fetch(`${APP_URL}/api/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': adminToken() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        throw new Error(`Backtest API error ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      debug.log('[Backtest] Result:', JSON.stringify(data).slice(0, 300));
      if (data.trades && data.candles) {
        onBacktestResult(data.trades, data.regimeChanges || [], data.candles);
      } else if (Array.isArray(data)) {
        onBacktestResult(data, [], []);
      } else if (data.error) {
        throw new Error(data.error);
      } else {
        debug.warn('[Backtest] Unexpected response shape:', data);
      }
    } catch (e) {
      debug.error('[Backtest] Failed:', e);
      alert(`Backtest failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsBacktesting(false);
    }
  }, [activeMode, riskConfigs, onBacktestResult, setIsBacktesting]);

  // Expose runBacktest via a ref-like pattern using useEffect on parent
  // Actually, parent calls this through the onRunBacktest prop pattern.
  // We handle the form rendering here and call runBacktest on button click.

  if (!showBacktestUI) return null;

  return (
    <div className="px-4 py-3 bg-amber-500/5 border-b border-white/5 flex flex-wrap gap-4 items-center animate-in slide-in-from-top-2 duration-200">
      <div className="flex items-center gap-2">
        <Calendar className="w-4 h-4 text-amber-400" />
        <span className="text-xs font-medium text-gray-300">Backtest Period:</span>
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor="bt-start" className="sr-only">Backtest start date</label>
        <input id="bt-start" type="date" value={backtestDates.start}
          max={new Date().toISOString().split('T')[0]}
          onChange={(e) => onBacktestDatesChange({ ...backtestDates, start: e.target.value })}
          aria-label="Backtest start date"
          className="bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:border-amber-500 focus-visible:outline-none caret-white" />
        <span className="text-gray-600">to</span>
        <label htmlFor="bt-end" className="sr-only">Backtest end date</label>
        <input id="bt-end" type="date" value={backtestDates.end}
          max={new Date().toISOString().split('T')[0]}
          onChange={(e) => onBacktestDatesChange({ ...backtestDates, end: e.target.value })}
          aria-label="Backtest end date"
          className="bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:border-amber-500 focus-visible:outline-none caret-white" />
      </div>
      <button onClick={() => {
          const start = new Date(backtestDates.start).getTime();
          const end = new Date(backtestDates.end).getTime() + 24 * 60 * 60 * 1000;
          runBacktest(start, end);
        }}
        disabled={isBacktesting}
        className="px-4 py-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black text-xs font-bold rounded transition-colors flex items-center gap-2 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none">
        {isBacktesting ? <Activity className="w-3 h-3 animate-pulse" /> : <Play className="w-3 h-3" />}
        {isBacktesting ? 'Running...' : 'Run Backtest'}
      </button>
      {backtestTrades.length > 0 && (
        <div className="flex gap-6 ml-auto bg-black/40 px-4 py-1.5 rounded-lg border border-amber-500/20">
          <div className="text-center">
            <p className="text-[10px] text-amber-500/60 uppercase font-bold tracking-wider">Win Rate</p>
            <p className="text-sm font-mono text-white font-bold">
              {(backtestTrades.filter(t => t.status === 'profit').length / backtestTrades.length * 100).toFixed(1)}%
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-amber-500/60 uppercase font-bold tracking-wider">Total PnL</p>
            <p className={`text-sm font-mono font-bold ${backtestTrades.reduce((acc, t) => acc + t.pnl, 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {backtestTrades.reduce((acc, t) => acc + t.pnl, 0).toFixed(2)}%
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-amber-500/60 uppercase font-bold tracking-wider">Trades</p>
            <p className="text-sm font-mono text-white font-bold">{backtestTrades.length}</p>
          </div>
        </div>
      )}
    </div>
  );
}
