/**
 * ChartPanel — lightweight-charts candlestick chart with indicator overlays,
 * trade markers, regime annotations, and the shadow trade history chart.
 *
 * Extracted from App() (originally lines ~527-820 for chart init/effects,
 * ~1082-1301 for indicators/markers/candles, ~2016-2180 for JSX layout).
 *
 * Props are explicit: data in (trades, backtestTrades, regime changes, etc.),
 * callbacks out (fetchCandles, changeTimeframe). No reach-back into App state.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  createChart, ColorType, IChartApi, ISeriesApi,
  CandlestickSeries, LineSeries, CrosshairMode,
  createSeriesMarkers, ISeriesMarkersPluginApi,
} from 'lightweight-charts';
import { Activity, History, Maximize2, Calendar, Play, X } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { safeFetch, APP_URL, debug } from '../api/client';

export interface IndicatorToggles {
  ema9: boolean; ema21: boolean; ema50: boolean; vwap: boolean; bb: boolean;
}

interface ChartPanelProps {
  status: { timeframe: string; symbol: string; [k: string]: any };
  trades: any[];
  backtestTrades: any[];
  backtestRegimeChanges: any[];
  liveRegimeChanges: any[];
  shadowTrades: any[];
  performance: any;
  activeMode: string;
  showBacktestUI: boolean;
  indicatorToggles: IndicatorToggles;
  onIndicatorToggle: (key: keyof IndicatorToggles) => void;
  onToggleBacktest: () => void;
  onResetZoom: () => void;
  onChangeTimeframe: (tf: string) => void;
  onRunBacktest: (start: number, end: number) => void;
  isBacktesting: boolean;
  backtestDates: { start: string; end: string };
  onBacktestDatesChange: (dates: { start: string; end: string }) => void;
  showSignalMarkers: boolean;
  showTradeMarkers: boolean;
  onToggleSignalMarkers: () => void;
  onToggleTradeMarkers: () => void;
  modeVisibility: Record<string, boolean>;
  onToggleModeVisibility: (mode: string) => void;
  onChangeActiveMode: (mode: string) => void;
  chartRef: React.MutableRefObject<IChartApi | null>;
  seriesRef: React.MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  onCurrentPriceChange: (price: number) => void;
  candleDataRef: React.MutableRefObject<any[]>;
}

const InfoButton = ({ text, position = "left-full ml-2 top-0" }: { text: string, position?: string }) => (
  <button
    type="button"
    aria-label={text}
    aria-describedby="info-tooltip"
    className="info-container relative inline-flex items-center justify-center ml-1 rounded focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus-visible:ring-offset-[#1e1e1e] focus-visible:outline-none cursor-help text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors"
  >
    <span id="info-tooltip" className="sr-only">{text}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    <div className={`info-tooltip ${position}`}>{text}</div>
  </button>
);

export default function ChartPanel(props: ChartPanelProps) {
  const {
    status, trades, backtestTrades, backtestRegimeChanges, liveRegimeChanges,
    shadowTrades, performance, activeMode, showBacktestUI, indicatorToggles,
    onIndicatorToggle, onToggleBacktest, onResetZoom, onChangeTimeframe,
    onRunBacktest, isBacktesting, backtestDates, onBacktestDatesChange,
    showSignalMarkers, showTradeMarkers, onToggleSignalMarkers, onToggleTradeMarkers,
    modeVisibility, onToggleModeVisibility, onChangeActiveMode,
    chartRef, seriesRef, onCurrentPriceChange, candleDataRef,
  } = props;

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const shadowChartContainerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const shadowChartRef = useRef<IChartApi | null>(null);
  const shadowSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const shadowMarkersRef = useRef<ISeriesMarkersPluginApi<any> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<any> | null>(null);
  const indicatorSeriesRef = useRef<Record<string, ISeriesApi<"Line">>>({});
  const lastBroadcastCandleTimeRef = useRef<number>(0);
  const backtestTradesRef = useRef<any[]>([]);
  const [isLoadingCandles, setIsLoadingCandles] = useState(false);

  useEffect(() => {
    backtestTradesRef.current = backtestTrades;
  }, [backtestTrades]);

  // ---- Chart initialization (main chart) ----
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;
    if (container.querySelector('.tv-lightweight-charts')) return;

    if (container.clientWidth <= 0 || container.clientHeight <= 0) {
      const raf = requestAnimationFrame(() => {
        if (container.clientWidth > 0) {
          initChart(container);
        } else {
          setTimeout(() => {
            if (chartContainerRef.current === container) {
              initChart(container);
            }
          }, 100);
        }
      });
      return () => cancelAnimationFrame(raf);
    }
    initChart(container);

    function initChart(div: HTMLDivElement) {
      const width = Math.max(div.clientWidth, 800);
      const height = Math.max(div.clientHeight, 400);
      const chart = createChart(div, {
        layout: { background: { type: ColorType.Solid, color: '#1e1e1e' }, textColor: '#d1d4dc' },
        grid: { vertLines: { color: '#2B2B43' }, horzLines: { color: '#2B2B43' } },
        crosshair: { mode: CrosshairMode.Normal },
        width, height,
      });
      const candlestickSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
        wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      });
      chartRef.current = chart;
      seriesRef.current = candlestickSeries;
      markersPluginRef.current = createSeriesMarkers(candlestickSeries);
      fetchCandles();

      chart.subscribeCrosshairMove((param) => {
        if (!legendRef.current) return;
        if (param.point === undefined || !param.time ||
            param.point.x < 0 || param.point.x > chartContainerRef.current!.clientWidth ||
            param.point.y < 0 || param.point.y > chartContainerRef.current!.clientHeight) {
          legendRef.current.style.display = 'none';
        } else {
          const data = param.seriesData.get(candlestickSeries) as any;
          if (data) {
            const date = new Date((param.time as number) * 1000);
            const timeStr = date.toLocaleString();
            const btTrade = backtestTradesRef.current.find(t =>
              Math.floor(t.time / 1000) === param.time || Math.floor(t.exitTime / 1000) === param.time);
            legendRef.current.style.display = 'flex';
            legendRef.current.innerHTML = `
              <div class="text-gray-400 mb-1">${timeStr}</div>
              <div class="flex gap-3 mb-2">
                <span class="text-gray-400">O <span class="text-white">${data.open.toFixed(2)}</span></span>
                <span class="text-gray-400">H <span class="text-white">${data.high.toFixed(2)}</span></span>
                <span class="text-gray-400">L <span class="text-white">${data.low.toFixed(2)}</span></span>
                <span class="text-gray-400">C <span class="text-white">${data.close.toFixed(2)}</span></span>
              </div>
              ${btTrade ? `
                <div class="bg-indigo-500 bg-opacity-20 border border-indigo-500 border-opacity-30 rounded p-2 text-xs">
                  <div class="font-bold text-indigo-300 mb-1">VIRTUAL TRADE: ${btTrade.side.toUpperCase()}</div>
                  <div class="text-gray-300 mb-1">${btTrade.reasoning}</div>
                  <div class="flex gap-2 text-[10px] text-gray-400">
                    <span>Indicators: ${btTrade.indicators.join(', ')}</span>
                  </div>
                  ${btTrade.exitTime ? `
                    <div class="mt-1 font-mono ${btTrade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}">
                      PnL: ${btTrade.pnl.toFixed(2)}% (${btTrade.status.toUpperCase()})
                    </div>` : ''}
                </div>` : ''}`;
          }
        }
      });

      const handleResize = () => {
        if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      };
      window.addEventListener('resize', handleResize);
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width } = entry.contentRect;
          if (chartRef.current && width > 0) chartRef.current.applyOptions({ width });
        }
      });
      resizeObserver.observe(div);
      return () => {
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        chart.remove();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Shadow chart initialization ----
  useEffect(() => {
    const container = shadowChartContainerRef.current;
    if (!container) return;
    if (container.querySelector('.tv-lightweight-charts')) return;

    if (container.clientWidth <= 0 || container.clientHeight <= 0) {
      const raf = requestAnimationFrame(() => {
        if (container.clientWidth > 0) {
          initShadowChart(container);
        } else {
          setTimeout(() => {
            if (shadowChartContainerRef.current === container) {
              initShadowChart(container);
            }
          }, 100);
        }
      });
      return () => cancelAnimationFrame(raf);
    }
    initShadowChart(container);

    function initShadowChart(div: HTMLDivElement) {
      const width = Math.max(div.clientWidth, 400);
      const height = Math.max(div.clientHeight, 200);
      const chart = createChart(div, {
        layout: { background: { type: ColorType.Solid, color: '#1e1e1e' }, textColor: '#d1d4dc' },
        grid: { vertLines: { color: '#2B2B43' }, horzLines: { color: '#2B2B43' } },
        width, height,
      });
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
        wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      });
      shadowChartRef.current = chart;
      shadowSeriesRef.current = candleSeries;
      shadowMarkersRef.current = createSeriesMarkers(candleSeries);

      const loadShadowData = () => {
        if (!shadowSeriesRef.current || shadowTrades.length === 0) return;
        const allPrices: any[] = [];
        for (const trade of shadowTrades) {
          const entryTime = Math.floor((trade.timestamp || trade.time || trade.entryTime) / 1000);
          const exitTime = trade.exitTimestamp ? Math.floor(trade.exitTimestamp / 1000) : null;
          const entryPrice = trade.entryPrice || trade.price;
          const exitPrice = trade.exitPrice || trade.exit_price;
          if (entryTime && entryPrice) allPrices.push({ time: entryTime, price: entryPrice });
          if (exitTime && exitPrice) allPrices.push({ time: exitTime, price: exitPrice });
        }
        allPrices.sort((a, b) => a.time - b.time);
        if (allPrices.length > 0) {
          candleSeries.setData(allPrices.map(p => ({
            time: p.time as any, open: p.price, high: p.price * 1.001,
            low: p.price * 0.999, close: p.price,
          })));
        }
        if (shadowMarkersRef.current) {
          const markers: any[] = [];
          for (const trade of shadowTrades) {
            const entryTime = Math.floor((trade.timestamp || trade.time || trade.entryTime) / 1000);
            const exitTime = trade.exitTimestamp ? Math.floor(trade.exitTimestamp / 1000) : null;
            const mode = trade.risk_mode || trade.mode || 'moderate';
            const modeColors: Record<string, string> = {
              ultra_conservative: '#6366f1', conservative: '#3b82f6', moderate: '#22c55e',
              aggressive: '#f59e0b', degen: '#ef4444', ai_enhanced: '#a855f7',
            };
            const color = modeColors[mode] || '#6366f1';
            if (entryTime) {
              markers.push({
                time: entryTime as any,
                position: trade.side === 'buy' || trade.side === 'long' ? 'belowBar' : 'aboveBar',
                color, shape: 'arrowUp',
                text: trade.side === 'buy' || trade.side === 'long' ? 'B' : 'S', size: 1,
              });
            }
            if (exitTime) {
              markers.push({
                time: exitTime as any,
                position: trade.side === 'buy' || trade.side === 'long' ? 'aboveBar' : 'belowBar',
                color, shape: trade.pnl > 0 ? 'arrowUp' : 'arrowDown', text: 'X', size: 1,
              });
            }
          }
          markers.sort((a, b) => a.time - b.time);
          shadowMarkersRef.current.setMarkers(markers);
        }
        chart.timeScale().fitContent();
      };
      setTimeout(loadShadowData, 100);

      const handleResize = () => {
        if (shadowChartContainerRef.current && shadowChartRef) {
          shadowChartRef.current?.applyOptions({ width: shadowChartContainerRef.current.clientWidth });
        }
      };
      window.addEventListener('resize', handleResize);
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width } = entry.contentRect;
          if (shadowChartRef.current && width > 0) shadowChartRef.current.applyOptions({ width });
        }
      });
      resizeObserver.observe(div);
      return () => {
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        chart.remove();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadowTrades]);

  // ---- Indicators update ----
  const updateIndicators = useCallback(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    const data = candleDataRef.current;
    const toggleSeries = (key: string, color: string, dataKey: string) => {
      if (indicatorToggles[key as keyof IndicatorToggles]) {
        if (!indicatorSeriesRef.current[key]) {
          indicatorSeriesRef.current[key] = chart.addSeries(LineSeries, {
            color, lineWidth: 2, crosshairMarkerVisible: false,
            lastValueVisible: false, priceLineVisible: false,
          });
        }
        const lineData = data.filter(d => d[dataKey] !== null && d[dataKey] !== undefined).map(d => ({
          time: d.time / 1000 as any, value: d[dataKey],
        }));
        indicatorSeriesRef.current[key].setData(lineData);
      } else {
        if (indicatorSeriesRef.current[key]) {
          chart.removeSeries(indicatorSeriesRef.current[key]);
          delete indicatorSeriesRef.current[key];
        }
      }
    };
    toggleSeries('ema9', '#3b82f6', 'ema_9');
    toggleSeries('ema21', '#f59e0b', 'ema_21');
    toggleSeries('ema50', '#ef4444', 'ema_50');
    toggleSeries('vwap', '#a855f7', 'vwap');
    if (indicatorToggles.bb) {
      ['bb_upper', 'bb_middle', 'bb_lower'].forEach((key, i) => {
        const refKey = `bb_${key}`;
        if (!indicatorSeriesRef.current[refKey]) {
          indicatorSeriesRef.current[refKey] = chart.addSeries(LineSeries, {
            color: i === 1 ? '#6366f1' : '#818cf8', lineWidth: i === 1 ? 2 : 1,
            lineStyle: i === 1 ? 0 : 2, crosshairMarkerVisible: false,
            lastValueVisible: false, priceLineVisible: false,
          });
        }
        const lineData = data.filter(d => d[key] !== null && d[key] !== undefined).map(d => ({
          time: d.time / 1000 as any, value: d[key],
        }));
        indicatorSeriesRef.current[refKey].setData(lineData);
      });
    } else {
      ['bb_upper', 'bb_middle', 'bb_lower'].forEach(key => {
        const refKey = `bb_${key}`;
        if (indicatorSeriesRef.current[refKey]) {
          chart.removeSeries(indicatorSeriesRef.current[refKey]);
          delete indicatorSeriesRef.current[refKey];
        }
      });
    }
  }, [indicatorToggles, chartRef, candleDataRef]);

  // ---- Markers update ----
  const updateMarkers = useCallback(() => {
    if (!seriesRef.current || candleDataRef.current.length === 0) return;
    const markers: any[] = [];
    const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    const candleTimes = candleDataRef.current.map(c => Math.floor(Number(c.time) / 1000));
    const getClosestTime = (timestampMs: number) => {
      const ts = Math.floor(timestampMs / 1000);
      let closest = candleTimes[0];
      for (const ct of candleTimes) {
        if (ct <= ts) closest = ct;
        else break;
      }
      return closest;
    };
    if (showTradeMarkers) {
      for (const trade of sortedTrades) {
        markers.push({
          time: getClosestTime(trade.timestamp) as any,
          position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
          color: trade.side === 'buy' ? '#26a69a' : '#ef5350',
          shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
          text: `${trade.side.toUpperCase()}`, size: 1,
        });
        if (trade.status === 'closed' && trade.exit_timestamp) {
          markers.push({
            time: getClosestTime(trade.exit_timestamp) as any,
            position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
            color: trade.pnl > 0 ? '#26a69a' : '#ef5350',
            shape: trade.side === 'buy' ? 'arrowDown' : 'arrowUp',
            text: 'EXIT', size: 1,
          });
        }
      }
    }
    for (const trade of backtestTrades) {
      const isProfit = trade.pnl > 0;
      markers.push({
        time: getClosestTime(trade.time) as any,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: isProfit ? '#4ade80' : '#f87171',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: `V-${trade.side.toUpperCase()}`, size: 1,
      });
      if (trade.exitTime) {
        markers.push({
          time: getClosestTime(trade.exitTime) as any,
          position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
          color: isProfit ? '#22c55e' : '#ef4444',
          shape: trade.side === 'buy' ? 'arrowDown' : 'arrowUp',
          text: `V-EXIT ${trade.pnl.toFixed(1)}%`, size: 1,
        });
      }
    }
    const activeRegimeChanges = showBacktestUI ? backtestRegimeChanges : liveRegimeChanges;
    for (const rc of activeRegimeChanges) {
      markers.push({
        time: getClosestTime(rc.time) as any, position: 'inBar', color: '#6366f1',
        shape: 'circle', text: `R: ${rc.regime.toUpperCase()}`, size: 1,
      });
    }
    markers.sort((a, b) => a.time - b.time);
    const uniqueMarkers: any[] = [];
    const seen = new Set();
    for (const m of markers) {
      const key = `${m.time}-${m.position}-${m.text}`;
      if (!seen.has(key)) { seen.add(key); uniqueMarkers.push(m); }
    }
    if (markersPluginRef.current) {
      markersPluginRef.current.setMarkers(uniqueMarkers);
    }
  }, [trades, backtestTrades, backtestRegimeChanges, liveRegimeChanges, showBacktestUI, showTradeMarkers, seriesRef, candleDataRef]);

  useEffect(() => { updateIndicators(); }, [indicatorToggles, updateIndicators]);
  useEffect(() => { updateMarkers(); }, [trades, backtestTrades, backtestRegimeChanges, liveRegimeChanges, showBacktestUI, updateMarkers]);

  // ---- Fetch candles ----
  const fetchCandles = useCallback(async (timeframe?: string) => {
    try {
      setIsLoadingCandles(true);
      const tf = timeframe || status.timeframe || '15m';
      let historyParam = '1y';
      if (tf === '1m') historyParam = '7d';
      else if (tf === '5m') historyParam = '30d';
      else if (tf === '15m') historyParam = '90d';
      else if (tf === '1h') historyParam = '180d';
      const result = await safeFetch(`${APP_URL}/api/candles?history=${historyParam}`);
      debug.log(`[fetchCandles] tf=${tf} history=${historyParam} ok=${result.ok} hasData=${!!result.data} hasSeries=${!!seriesRef.current} isArray=${Array.isArray(result?.data)} len=${Array.isArray(result?.data) ? result.data.length : 'N/A'}`);
      if (result.ok && result.data && seriesRef.current && Array.isArray(result.data)) {
        candleDataRef.current = result.data;
        const formattedData = result.data
          .map((c: any) => ({
            time: Math.floor(Number(c.time) / 1000) as any, open: Number(c.open),
            high: Number(c.high), low: Number(c.low), close: Number(c.close),
          }))
          .filter((c: any) => !isNaN(c.time))
          .sort((a: any, b: any) => a.time - b.time);
        const uniqueData: any[] = [];
        for (let i = 0; i < formattedData.length; i++) {
          if (i === 0 || formattedData[i].time > formattedData[i-1].time) uniqueData.push(formattedData[i]);
        }
        seriesRef.current.setData(uniqueData);
        debug.log(`[chart] setData ${uniqueData.length} items, first=${JSON.stringify(uniqueData[0])}, last=${JSON.stringify(uniqueData[uniqueData.length-1])}`);
        updateIndicators();
        updateMarkers();
        if (chartRef.current) chartRef.current.timeScale().fitContent();
      }
    } catch (e) {
      debug.error(e);
    } finally {
      setIsLoadingCandles(false);
    }
  }, [status.timeframe, seriesRef, chartRef, candleDataRef, updateIndicators, updateMarkers]);

  // Expose fetchCandles to parent via ref pattern (called on timeframe change)
  useEffect(() => {
    if (!showBacktestUI) {
      fetchCandles();
    }
  }, [showBacktestUI, fetchCandles]);

  // ---- Render ----
  return (
    <div className="lg:col-span-2 space-y-6">
      {/* Main Chart Card */}
      <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.1)]' : 'border-white/5'} overflow-hidden`}>
        <div className="p-4 border-b border-white/5 flex justify-between items-center">
          <h2 className="font-medium flex items-center gap-2">
            <Activity className={`w-4 h-4 ${showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`} />
            {showBacktestUI ? 'Backtest Simulation' : 'Live Market Data'}
          </h2>
          <div className="flex gap-2">
            <button onClick={onToggleBacktest}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
                showBacktestUI ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-white/5 hover:bg-white/10 text-gray-400 border border-transparent'}`}
              title="Backtest Mode">
              <History className="w-3.5 h-3.5" />Backtest
            </button>
            <button onClick={onResetZoom}
              className="px-2 py-1 text-xs rounded bg-white/5 hover:bg-white/10 text-gray-400 border border-transparent mr-2 flex items-center gap-1 transition-colors"
              title="Reset Zoom/Pan" aria-label="Reset chart zoom and pan">
              <Maximize2 className="w-3 h-3" />
            </button>
            {['1m', '5m', '15m', '1h', '4h'].map(tf => (
              <button key={tf} onClick={() => onChangeTimeframe(tf)}
                className={`px-2 py-1 text-xs rounded transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none ${
                  status.timeframe === tf ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'bg-white/5 hover:bg-white/10 text-gray-400 border border-transparent'}`}>
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* Indicator toggles */}
        <div className="px-4 py-2 border-b border-white/5 flex gap-2 items-center overflow-x-auto">
          <div className="flex items-center gap-1 mr-2">
            <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Indicators:</span>
            <InfoButton text="Technical indicators used to identify market trends and potential entry/exit points." position="left-full ml-1 top-0" />
          </div>
          {(['ema9', 'ema21', 'ema50', 'vwap', 'bb'] as const).map(key => {
            const colors: Record<string, string> = {
              ema9: 'blue-500', ema21: 'amber-500', ema50: 'red-500', vwap: 'purple-500', bb: 'indigo-500',
            };
            const labels: Record<string, string> = {
              ema9: 'EMA 9', ema21: 'EMA 21', ema50: 'EMA 50', vwap: 'VWAP', bb: 'Bollinger Bands',
            };
            const descs: Record<string, string> = {
              ema9: 'Exponential Moving Average (9 periods). Short-term trend indicator.',
              ema21: 'Exponential Moving Average (21 periods). Medium-term trend indicator.',
              ema50: 'Exponential Moving Average (50 periods). Long-term trend indicator.',
              vwap: 'Volume Weighted Average Price. Benchmark for the average price a security has traded at throughout the day.',
              bb: 'Volatility indicator consisting of a middle SMA and two standard deviation bands.',
            };
            const c = colors[key];
            return (
              <div key={key} className="flex items-center gap-1">
                <button onClick={() => onIndicatorToggle(key)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors focus-visible:ring-2 focus-visible:ring-${c}/50 focus-visible:outline-none ${indicatorToggles[key] ? `bg-${c}/20 text-${c}-400 border border-${c}/30` : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}>
                  {labels[key]}
                </button>
                <InfoButton text={descs[key]} position="bottom-full mb-2 left-0" />
              </div>
            );
          })}
        </div>

        {/* Backtest date range bar */}
        {showBacktestUI && (
          <div className="px-4 py-3 bg-amber-500/5 border-b border-white/5 flex flex-wrap gap-4 items-center animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-medium text-gray-300">Backtest Period:</span>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="backtest-start" className="sr-only">Backtest start date</label>
              <input id="backtest-start" type="date" value={backtestDates.start}
                max={new Date().toISOString().split('T')[0]}
                onChange={(e) => onBacktestDatesChange({ ...backtestDates, start: e.target.value })}
                aria-label="Backtest start date"
                className="bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:border-amber-500 focus-visible:outline-none caret-white" />
              <span className="text-gray-600">to</span>
              <label htmlFor="backtest-end" className="sr-only">Backtest end date</label>
              <input id="backtest-end" type="date" value={backtestDates.end}
                max={new Date().toISOString().split('T')[0]}
                onChange={(e) => onBacktestDatesChange({ ...backtestDates, end: e.target.value })}
                aria-label="Backtest end date"
                className="bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:border-amber-500 focus-visible:outline-none caret-white" />
            </div>
            <button onClick={() => {
              const start = new Date(backtestDates.start).getTime();
              const end = new Date(backtestDates.end).getTime() + 24 * 60 * 60 * 1000;
              onRunBacktest(start, end);
            }} disabled={isBacktesting}
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
        )}

        {/* Chart canvas */}
        <div className="relative w-full min-h-[400px]">
          {isLoadingCandles && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#1e1e1e]/80 backdrop-blur-sm">
              <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2"></div>
              <div className="text-indigo-400 font-mono text-sm animate-pulse">Loading 1 Year Historical Data...</div>
            </div>
          )}
          <div ref={chartContainerRef} className="w-full h-[400px]" />
          <div ref={legendRef}
            className="absolute top-3 left-3 z-10 pointer-events-none text-xs font-mono bg-[#1e1e1e]/80 p-2 rounded border border-white/10 backdrop-blur-sm flex-col gap-1 shadow-lg"
            style={{ display: 'none' }} />
        </div>
      </div>

      {/* Shadow Trade History Chart */}
      <div className="bg-[#1e1e1e] rounded-xl border border-white/5 overflow-hidden">
        <div className="p-4 border-b border-white/5">
          <h2 className="font-medium flex items-center gap-2">
            <Activity className="w-4 h-4 text-purple-400" />Shadow Trade History
          </h2>
        </div>
        <div ref={shadowChartContainerRef} className="w-full h-[250px]" />
      </div>

      {/* Shadow Comparison / Performance chart + table */}
      <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30' : 'border-white/5'} p-4`}>
        <h2 className={`font-medium mb-4 ${showBacktestUI ? 'text-amber-400' : ''}`}>
          {showBacktestUI ? 'Backtest Performance Comparison' : 'Shadow Portfolio Comparison'}
        </h2>
        <div className="h-[180px] w-full mb-6" style={{ minHeight: 180 }}>
          {(performance[activeMode]?.history?.length > 0) ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={performance[activeMode]?.history || []}>
                <defs>
                  <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={showBacktestUI ? "#f59e0b" : "#6366f1"} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={showBacktestUI ? "#f59e0b" : "#6366f1"} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                <XAxis dataKey="time" hide />
                <YAxis domain={['auto', 'auto']} hide />
                <Tooltip content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    return (
                      <div className="bg-[#1e1e1e] border border-white/10 p-2 rounded shadow-xl text-[10px] font-mono">
                        <p className="text-gray-400">{new Date(payload[0].payload.time).toLocaleString()}</p>
                        <p className={showBacktestUI ? "text-amber-400" : "text-indigo-400"}>
                          Balance: ${(payload[0].value as number).toFixed(2)}
                        </p>
                      </div>
                    );
                  }
                  return null;
                }} />
                <Area type="monotone" dataKey="balance" stroke={showBacktestUI ? "#f59e0b" : "#6366f1"}
                  fillOpacity={1} fill="url(#colorBalance)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm">No performance data yet</div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className={`text-xs uppercase ${showBacktestUI ? 'text-amber-500/60 bg-amber-500/5' : 'text-gray-400 bg-white/5'}`}>
              <tr>
                <th className="px-4 py-3 rounded-tl-lg">Risk Mode</th>
                <th className="px-4 py-3">Balance</th>
                <th className="px-4 py-3">ROI</th>
                <th className="px-4 py-3">Win Rate</th>
                <th className="px-4 py-3 rounded-tr-lg">Trades</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(performance).map(([mode, data]: [string, any]) => (
                <tr key={mode}
                  className={`border-b border-white/5 cursor-pointer transition-colors ${
                    activeMode === mode
                      ? (showBacktestUI ? 'bg-amber-500/10' : 'bg-indigo-500/10')
                      : (showBacktestUI ? 'hover:bg-amber-500/5' : 'hover:bg-white/5')}`}
                  onClick={() => onChangeActiveMode(mode)}>
                  <td className="px-4 py-3 font-medium capitalize">{mode.replace('_', ' ')}</td>
                  <td className="px-4 py-3 font-mono">${data.balance.toFixed(2)}</td>
                  <td className={`px-4 py-3 font-mono ${data.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {data.roi > 0 ? '+' : ''}{data.roi.toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 font-mono">{data.winRate.toFixed(1)}%</td>
                  <td className="px-4 py-3 font-mono">{data.tradesCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Chart Markers Toggle bar */}
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] text-gray-400 uppercase tracking-wider">Chart Markers</span>
          <div className="flex gap-2">
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={showSignalMarkers} onChange={onToggleSignalMarkers}
                aria-label="Show signal markers on chart" className="w-2.5 h-2.5 accent-indigo-500" />
              <span className="text-[8px] text-gray-400">Signals</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={showTradeMarkers} onChange={onToggleTradeMarkers}
                aria-label="Show trade markers on chart" className="w-2.5 h-2.5 accent-indigo-500" />
              <span className="text-[8px] text-gray-400">Trades</span>
            </label>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(modeVisibility).map(([mode, visible]) => {
            const dotColors: Record<string, string> = {
              ultra_conservative: 'bg-indigo-500', conservative: 'bg-blue-500', moderate: 'bg-emerald-500',
              aggressive: 'bg-amber-500', degen: 'bg-red-500', ai_enhanced: 'bg-purple-500',
            };
            return (
              <button key={mode} onClick={() => onToggleModeVisibility(mode)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] transition-colors ${
                  visible ? 'bg-white/10 text-white' : 'bg-white/[0.03] text-gray-600'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${dotColors[mode] || 'bg-gray-500'}`} />
                {mode.replace('_', ' ')}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
