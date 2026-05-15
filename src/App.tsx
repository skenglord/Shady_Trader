import React, { useEffect, useState, useRef } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickSeries, LineSeries, CrosshairMode, createSeriesMarkers, ISeriesMarkersPluginApi } from 'lightweight-charts';
import { Activity, TrendingUp, TrendingDown, Minus, AlertCircle, Settings, Play, Square, X, Maximize2, Calendar, History, Info, ExternalLink } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

const APP_URL = '';

function getProviderDocsUrl(provider: string): string {
  const docs: Record<string, string> = {
    coinmarketcap: 'https://coinmarketcap.com/api/documentation/v1/',
    coingecko: 'https://docs.coingecko.com/reference/coins-id-ohlc',
    cryptocompare: 'https://min-api.cryptocompare.com/documentation/key=Historical&cat=dataHistoday',
    binance: 'https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data',
    kraken: 'https://docs.kraken.com/rest/endpoints/public/OHLC',
    okx: 'https://www.okx.com/docs-v5/en/#market-data',
    coinbase: 'https://docs.cloud.coinbase.com/exchange/reference/exchangerestapi_getproductcandles'
  };
  return docs[provider] || 'https://example.com';
}

const InfoButton = ({ text, position = "left-full ml-2 top-0" }: { text: string, position?: string }) => (
  <div className="info-container relative inline-block ml-1">
    <Info size={12} className="text-gray-500 cursor-help hover:text-gray-300 transition-colors" />
    <div className={`info-tooltip ${position}`}>
      {text}
    </div>
  </div>
);

const StatusLight = ({ isLive, apiName, isDataPassing, lastCallTime }: { isLive: boolean, apiName: string, isDataPassing: boolean, lastCallTime: number }) => {
  const [isFlashing, setIsFlashing] = useState(false);
  
  useEffect(() => {
    if (lastCallTime > 0) {
      setIsFlashing(true);
      const timer = setTimeout(() => setIsFlashing(false), 150);
      return () => clearTimeout(timer);
    }
  }, [lastCallTime]);

  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full transition-all duration-100 ${
        isLive && isDataPassing 
          ? (isFlashing ? 'bg-emerald-400 scale-125 shadow-[0_0_15px_rgba(52,211,153,1)]' : 'bg-emerald-600 shadow-[0_0_10px_rgba(5,150,105,0.6)]') 
          : 'bg-red-600 shadow-[0_0_10px_rgba(220,38,38,0.6)]'
      }`}></div>
      <span className="text-xs text-gray-400 font-mono">
        {isLive && isDataPassing ? `API: ${apiName}` : 'OFFLINE'}
      </span>
    </div>
  );
};

enum RiskMode {
  ULTRA_CONSERVATIVE = "ultra_conservative",
  CONSERVATIVE = "conservative",
  MODERATE = "moderate",
  AGGRESSIVE = "aggressive",
  DEGEN = "degen"
}

export default function App() {
  const [status, setStatus] = useState({ isRunning: false, currentRegime: 'uncertain', symbol: 'BTC/USDT', timeframe: '15m' });
  const [performance, setPerformance] = useState<any>({});
  const [regimeReasoning, setRegimeReasoning] = useState('');
  const [currentPrice, setCurrentPrice] = useState(0);
  const [trades, setTrades] = useState<any[]>([]);
  const [activeMode, setActiveMode] = useState('moderate');
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({
    symbol: 'BTC/USDT',
    timeframe: '15m',
    apiKey: '',
    apiSecret: '',
    apiPassword: '',
    testnet: 'true',
    aiStrategySwitching: 'false',
    aiSignalGeneration: 'false',
    aiSentimentAnalysis: 'false',
    exchange: 'coinmarketcap',
    strategy: 'regime',
    shotgunTimeBefore: '0.5',
    shotgunTimeAfter: '10',
    altChaserPercentage: '1',
    chasingDragonsLeverage: '7',
    chasingDragonsStopLoss: '6',
    baseUrl: '',
    wsUrl: '',
    apiProviders: {
      binance: true,
      bybit: true,
      okx: true,
      kraken: true,
      coinbase: true
    },
    systemJsonConfig: '{}'
  });
  const [riskConfigs, setRiskConfigs] = useState<Record<string, any>>({});
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [backtestTrades, setBacktestTrades] = useState<any[]>([]);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const defaultBalances = { mainBalance: 0, botBalance: 0, activeTradeBalance: 0, totalPnl: 0, totalPnlPct: 0 };
  const [balances, setBalances] = useState<typeof defaultBalances>(defaultBalances);

  // Safe setter that always merges with defaults
  const updateBalances = (data: Partial<typeof defaultBalances>) => {
    setBalances(prev => ({ ...defaultBalances, ...prev, ...data }));
  };
  const [marketData, setMarketData] = useState<any>(null);
  const [marketNews, setMarketNews] = useState<any[]>([]);
  const [isRefreshingMarket, setIsRefreshingMarket] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [balanceModalType, setBalanceModalType] = useState<'allocate' | 'withdraw'>('allocate');
  const [balanceAmount, setBalanceAmount] = useState('');
  const [indicatorToggles, setIndicatorToggles] = useState({
    ema9: false,
    ema21: false,
    ema50: false,
    vwap: false,
    bb: false
  });
  const [showBacktestUI, setShowBacktestUI] = useState(false);
  const [openPositions, setOpenPositions] = useState<any[]>([]);
  const [backtestDates, setBacktestDates] = useState({
    start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });
  const [backtestRegimeChanges, setBacktestRegimeChanges] = useState<any[]>([]);
  const [liveRegimeChanges, setLiveRegimeChanges] = useState<any[]>([]);
  const [isDataPassing, setIsDataPassing] = useState(false);
  const [lastCallTime, setLastCallTime] = useState(0);
  const [editingPosition, setEditingPosition] = useState<string | null>(null);
  const [editSl, setEditSl] = useState<number>(0);
  const [editTp, setEditTp] = useState<number>(0);
  const lastMessageTimeRef = useRef(0);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<any> | null>(null);
  const indicatorSeriesRef = useRef<Record<string, ISeriesApi<"Line">>>({});
  const candlesDataRef = useRef<any[]>([]);
  const backtestTradesRef = useRef<any[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    backtestTradesRef.current = backtestTrades;
  }, [backtestTrades]);

  useEffect(() => {
    fetchStatus();
    fetchPerformance();
    fetchTrades();
    fetchSettings();
    fetchRiskConfigs();
    fetchBalances();
    fetchOpenPositions();
    fetchMarketData();
    fetchMarketNews();

    // Setup WebSocket with timeout
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    // Connection timeout - prevent hanging forever
    const wsTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        console.warn('WebSocket connection timeout, continuing without WS');
        ws.close();
      }
    }, 5000);

    ws.onopen = () => {
      clearTimeout(wsTimeout);
      console.log('WebSocket connected');
    };

    ws.onerror = (error) => {
      clearTimeout(wsTimeout);
      console.warn('WebSocket error:', error);
    };

    ws.onclose = () => {
      clearTimeout(wsTimeout);
    };

    wsRef.current = ws;

    ws.onmessage = (event) => {
      lastMessageTimeRef.current = Date.now();
      setIsDataPassing(true);
      const data = JSON.parse(event.data);
      if (data.type === 'status') {
        setStatus(prev => ({ ...prev, ...data.data }));
      } else if (data.type === 'regime') {
        setStatus(prev => ({ ...prev, currentRegime: data.data.regime }));
        setRegimeReasoning(data.data.reasoning || '');
        setLiveRegimeChanges(prev => [...prev, { time: Date.now(), regime: data.data.regime }]);
      } else if (data.type === 'performance') {
        setPerformance(data.data);
      } else if (data.type === 'candle') {
        if (seriesRef.current && !showBacktestUI) {
          const c = data.data;
          setCurrentPrice(c.close);
          const time = Math.floor(Number(c.time) / 1000);
          if (!isNaN(time)) {
            seriesRef.current.update({
              time: time as any,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
            });
          }
        }
      } else if (data.type === 'signal') {
        fetchTrades();
      } else if (data.type === 'ai_mode_switch') {
        setActiveMode(data.data.mode);
      } else if (data.type === 'balances') {
        updateBalances(data.data);
      }
    };

    const interval = setInterval(() => {
      fetchOpenPositions();
      if (Date.now() - lastMessageTimeRef.current > 5000) {
        setIsDataPassing(false);
      }
    }, 1000);

    return () => {
      ws.close();
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (chartContainerRef.current) {
      const chart = createChart(chartContainerRef.current, {
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
        width: chartContainerRef.current.clientWidth,
        height: 400,
      });

      const candlestickSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });

      chartRef.current = chart;
      seriesRef.current = candlestickSeries;
      markersPluginRef.current = createSeriesMarkers(candlestickSeries);
      
      fetchCandles();

      chart.subscribeCrosshairMove((param) => {
        if (!legendRef.current) return;
        
        if (
          param.point === undefined ||
          !param.time ||
          param.point.x < 0 ||
          param.point.x > chartContainerRef.current!.clientWidth ||
          param.point.y < 0 ||
          param.point.y > chartContainerRef.current!.clientHeight
        ) {
          legendRef.current.style.display = 'none';
        } else {
          const data = param.seriesData.get(candlestickSeries) as any;
          if (data) {
            const date = new Date((param.time as number) * 1000);
            const timeStr = date.toLocaleString();
            legendRef.current.style.display = 'flex';
            
            // Check for backtest trade at this time
            const btTrade = backtestTradesRef.current.find(t => Math.floor(t.time / 1000) === param.time || Math.floor(t.exitTime / 1000) === param.time);
            
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
                    </div>
                  ` : ''}
                </div>
              ` : ''}
            `;
          }
        }
      });

      const handleResize = () => {
        if (chartContainerRef.current) {
          chart.applyOptions({ width: chartContainerRef.current.clientWidth });
        }
      };

      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
        chart.remove();
      };
    }
  }, []);

  const fetchStatus = async () => {
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/status`);
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchPerformance = async () => {
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/performance`);
      const data = await res.json();
      setPerformance(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchTrades = async () => {
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/trades?limit=10`);
      const data = await res.json();
      setTrades(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchSettings = async () => {
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/settings`);
      const data = await res.json();
      setSettings(prev => ({ ...prev, ...data }));
    } catch (e) {
      console.error(e);
    }
  };

  const fetchRiskConfigs = async () => {
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/risk-configs`);
      const data = await res.json();
      setRiskConfigs(data);
    } catch (e) {
      console.error(e);
    }
  };

  const saveRiskConfigs = async () => {
    try {
      setLastCallTime(Date.now());
      await fetch(`${APP_URL}/api/risk-configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(riskConfigs)
      });
      setShowConfigModal(false);
    } catch (e) {
      console.error(e);
    }
  };

  const resetRiskConfigs = async () => {
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/risk-configs/reset`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setRiskConfigs(data.configs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const getAiRecommendations = async () => {
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/risk-configs/ai-recommend`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setRiskConfigs(data.configs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const runBacktest = async (startTime?: number, endTime?: number) => {
    if (!riskConfigs[activeMode]) return;
    
    setIsBacktesting(true);
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: activeMode,
          config: riskConfigs[activeMode],
          startTime,
          endTime
        })
      });
      const data = await res.json();
      
      if (data.trades && data.candles) {
        setBacktestTrades(data.trades);
        setBacktestRegimeChanges(data.regimeChanges || []);
        
        // Update chart with backtest candles merged with existing candles
        if (seriesRef.current && Array.isArray(data.candles)) {
          // Merge existing candles with backtest candles
          const mergedCandles = [...candlesDataRef.current, ...data.candles];
          
          // Remove duplicates by time
          const uniqueCandlesMap = new Map();
          mergedCandles.forEach(c => uniqueCandlesMap.set(c.time, c));
          const uniqueCandles = Array.from(uniqueCandlesMap.values()).sort((a: any, b: any) => a.time - b.time);
          
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
          
          // Remove duplicates in formatted data
          const uniqueData = [];
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
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsBacktesting(false);
    }
  };

  useEffect(() => {
    if (showConfigModal && !showBacktestUI) {
      runBacktest();
    } else if (!showConfigModal && !showBacktestUI) {
      setBacktestTrades([]);
    }
  }, [showConfigModal, activeMode, riskConfigs[activeMode], showBacktestUI]);

  useEffect(() => {
    if (!showBacktestUI) {
      fetchCandles();
      setBacktestTrades([]);
    }
  }, [showBacktestUI]);

  const saveSettings = async () => {
    try {
      setLastCallTime(Date.now());
      await fetch(`${APP_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      setShowSettings(false);
      fetchStatus();
      fetchCandles();
    } catch (e) {
      console.error(e);
    }
  };

  const updateIndicators = () => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    const data = candlesDataRef.current;
    
    const toggleSeries = (key: string, color: string, dataKey: string) => {
      if (indicatorToggles[key as keyof typeof indicatorToggles]) {
        if (!indicatorSeriesRef.current[key]) {
          indicatorSeriesRef.current[key] = chart.addSeries(LineSeries, {
            color,
            lineWidth: 2,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
          });
        }
        const lineData = data.filter(d => d[dataKey] !== null && d[dataKey] !== undefined).map(d => ({
          time: d.time / 1000 as any,
          value: d[dataKey]
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
            color: i === 1 ? '#6366f1' : '#818cf8',
            lineWidth: i === 1 ? 2 : 1,
            lineStyle: i === 1 ? 0 : 2,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
          });
        }
        const lineData = data.filter(d => d[key] !== null && d[key] !== undefined).map(d => ({
          time: d.time / 1000 as any,
          value: d[key]
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
  };

  const updateMarkers = () => {
    if (!seriesRef.current || candlesDataRef.current.length === 0) return;
    const markers: any[] = [];
    
    const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    const candleTimes = candlesDataRef.current.map(c => Math.floor(Number(c.time) / 1000));
    
    const getClosestTime = (timestampMs: number) => {
      const ts = Math.floor(timestampMs / 1000);
      let closest = candleTimes[0];
      for (const ct of candleTimes) {
        if (ct <= ts) {
          closest = ct;
        } else {
          break;
        }
      }
      return closest;
    };
    
    for (const trade of sortedTrades) {
      markers.push({
        time: getClosestTime(trade.timestamp) as any,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: trade.side === 'buy' ? '#26a69a' : '#ef5350',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: `${trade.side.toUpperCase()}`,
        size: 1,
      });
      
      if (trade.status === 'closed' && trade.exit_timestamp) {
        markers.push({
          time: getClosestTime(trade.exit_timestamp) as any,
          position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
          color: trade.pnl > 0 ? '#26a69a' : '#ef5350',
          shape: trade.side === 'buy' ? 'arrowDown' : 'arrowUp',
          text: `EXIT`,
          size: 1,
        });
      }
    }
    
    // Add backtest markers
    for (const trade of backtestTrades) {
      const isProfit = trade.pnl > 0;
      markers.push({
        time: getClosestTime(trade.time) as any,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: isProfit ? '#4ade80' : '#f87171',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: `V-${trade.side.toUpperCase()}`,
        size: 1,
      });
      
      if (trade.exitTime) {
        markers.push({
          time: getClosestTime(trade.exitTime) as any,
          position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
          color: isProfit ? '#22c55e' : '#ef4444',
          shape: trade.side === 'buy' ? 'arrowDown' : 'arrowUp',
          text: `V-EXIT ${trade.pnl.toFixed(1)}%`,
          size: 1,
        });
      }
    }

    // Add regime changes
    const activeRegimeChanges = showBacktestUI ? backtestRegimeChanges : liveRegimeChanges;
    for (const rc of activeRegimeChanges) {
      markers.push({
        time: getClosestTime(rc.time) as any,
        position: 'inBar',
        color: '#6366f1', // Indigo
        shape: 'circle',
        text: `R: ${rc.regime.toUpperCase()}`,
        size: 1,
      });
    }

    // Sort markers by time
    markers.sort((a, b) => a.time - b.time);
    
    // Remove duplicates at the same time and position
    const uniqueMarkers = [];
    const seen = new Set();
    for (const m of markers) {
      const key = `${m.time}-${m.position}-${m.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueMarkers.push(m);
      }
    }
    
    if (markersPluginRef.current) {
      markersPluginRef.current.setMarkers(uniqueMarkers);
    }
  };

  useEffect(() => {
    updateIndicators();
  }, [indicatorToggles]);

  useEffect(() => {
    updateMarkers();
  }, [trades, backtestTrades, backtestRegimeChanges, liveRegimeChanges, showBacktestUI]);

  const [isLoadingCandles, setIsLoadingCandles] = useState(false);

  async function fetchCandles() {
    try {
      setIsLoadingCandles(true);
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/candles?history=1y`);
      const data = await res.json();
      if (seriesRef.current && Array.isArray(data)) {
        candlesDataRef.current = data;
        const formattedData = data
          .map((c: any) => ({
            time: Math.floor(Number(c.time) / 1000) as any,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
          }))
          .filter((c: any) => !isNaN(c.time))
          .sort((a: any, b: any) => a.time - b.time);

        // Remove duplicates
        const uniqueData = [];
        for (let i = 0; i < formattedData.length; i++) {
          if (i === 0 || formattedData[i].time > formattedData[i-1].time) {
            uniqueData.push(formattedData[i]);
          }
        }

        seriesRef.current.setData(uniqueData);
        updateIndicators();
        updateMarkers();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingCandles(false);
    }
  }

  const toggleEngine = async () => {
    try {
      setLastCallTime(Date.now());
      const endpoint = status.isRunning ? '/api/stop' : '/api/start';
      const response = await fetch(`${APP_URL}${endpoint}`, { method: 'POST' });
      if (response.ok) {
        fetchStatus();
      } else {
        const err = await response.json();
        console.error('Engine toggle failed:', err);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const manualTrade = async (side: 'buy' | 'sell') => {
    if (currentPrice === 0) return;
    
    // Start engine if not running
    if (!status.isRunning) {
      try {
        setLastCallTime(Date.now());
        await fetch(`${APP_URL}/api/start`, { method: 'POST' });
        setStatus(prev => ({ ...prev, isRunning: true }));
      } catch (e) {
        console.error('Failed to auto-start engine for manual trade:', e);
      }
    }

    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/manual-trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          symbol: status.symbol,
          price: currentPrice,
          stopLoss: side === 'buy' ? currentPrice * 0.98 : currentPrice * 1.02,
          takeProfit: side === 'buy' ? currentPrice * 1.02 : currentPrice * 0.98
        })
      });
      const result = await response.json();
      if (!result.success) {
        alert(result.error);
      }
      fetchTrades();
      fetchOpenPositions();
    } catch (e) {
      console.error(e);
      alert('Failed to execute trade');
    }
  };

  const changeTimeframe = async (tf: string) => {
    try {
      setLastCallTime(Date.now());
      await fetch(`${APP_URL}/api/timeframe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ timeframe: tf })
      });
      fetchStatus();
      fetchCandles();
    } catch (e) {
      console.error(e);
    }
  };

  const getRegimeColor = (regime: string) => {
    switch (regime) {
      case 'strong_bull': return 'text-emerald-500 bg-emerald-500 bg-opacity-10 border border-emerald-500 border-opacity-20';
      case 'weak_bull': return 'text-green-400 bg-green-400 bg-opacity-10 border border-green-400 border-opacity-20';
      case 'bear': return 'text-red-500 bg-red-500 bg-opacity-10 border border-red-500 border-opacity-20';
      case 'sideways': return 'text-blue-400 bg-blue-400 bg-opacity-10 border border-blue-400 border-opacity-20';
      default: return 'text-gray-400 bg-gray-400 bg-opacity-10 border border-gray-400 border-opacity-20';
    }
  };

  const getRegimeIcon = (regime: string) => {
    switch (regime) {
      case 'strong_bull':
      case 'weak_bull': return <TrendingUp className="w-4 h-4" />;
      case 'bear': return <TrendingDown className="w-4 h-4" />;
      case 'sideways': return <Minus className="w-4 h-4" />;
      default: return <AlertCircle className="w-4 h-4" />;
    }
  };

  const fetchBalances = async () => {
    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/balances`);
      const data = await response.json();
      updateBalances(data);
    } catch (e) {
      console.error('Failed to fetch balances:', e);
    }
  };

  const fetchMarketData = async () => {
    try {
      const response = await fetch(`${APP_URL}/api/market/data`);
      const data = await response.json();
      setMarketData(data);
    } catch (e) {
      console.error('Failed to fetch market data:', e);
    }
  };

  const fetchMarketNews = async () => {
    try {
      const response = await fetch(`${APP_URL}/api/market/news`);
      const data = await response.json();
      setMarketNews(data);
    } catch (e) {
      console.error('Failed to fetch market news:', e);
    }
  };

  const refreshMarketData = async () => {
    setIsRefreshingMarket(true);
    try {
      setLastCallTime(Date.now());
      await fetch(`${APP_URL}/api/market/refresh`, { method: 'POST' });
      await fetchMarketData();
      await fetchMarketNews();
    } catch (e) {
      console.error('Failed to refresh market data:', e);
    } finally {
      setIsRefreshingMarket(false);
    }
  };

  const runOptimization = async () => {
    setIsOptimizing(true);
    try {
      setLastCallTime(Date.now());
      const res = await fetch(`${APP_URL}/api/optimize`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        await fetchRiskConfigs();
      }
    } catch (e) {
      console.error('Failed to run optimization:', e);
    } finally {
      setIsOptimizing(false);
    }
  };

  const fetchOpenPositions = async () => {
    try {
      setLastCallTime(Date.now());
      const url = `${APP_URL}/api/positions/open`;
      console.log('Fetching:', url);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setOpenPositions(data);
    } catch (e) {
      console.error('Failed to fetch open positions:', e);
    }
  };

  const allocateBalance = async (amount: number) => {
    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/balances/allocate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount })
      });
      const data = await response.json();
      if (data.balances) updateBalances(data.balances);
      if (data.error) alert(data.error);
    } catch (e) {
      console.error('Failed to allocate balance:', e);
    }
  };

  const withdrawBalance = async (amount: number) => {
    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/balances/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount })
      });
      const data = await response.json();
      if (data.balances) updateBalances(data.balances);
      if (data.error) alert(data.error);
    } catch (e) {
      console.error('Failed to withdraw balance:', e);
    }
  };

  const halfBalance = async () => {
    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/balances/half`, { method: 'POST' });
      const data = await response.json();
      if (data.balances) updateBalances(data.balances);
    } catch (e) {
      console.error('Failed to half balance:', e);
    }
  };

  const doubleBalance = async () => {
    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/balances/double`, { method: 'POST' });
      const data = await response.json();
      if (data.balances) updateBalances(data.balances);
      if (data.error) alert(data.error);
    } catch (e) {
      console.error('Failed to double balance:', e);
    }
  };

  const closePosition = async (tradeId: string) => {
    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/positions/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeId, currentPrice })
      });
      const data = await response.json();
      if (data.success) {
        fetchOpenPositions();
        fetchTrades();
        fetchBalances();
      }
    } catch (e) {
      console.error('Failed to close position:', e);
    }
  };

  const updatePositionParams = async (tradeId: string, stopLoss: number, takeProfit: number) => {
    try {
      setLastCallTime(Date.now());
      const response = await fetch(`${APP_URL}/api/positions/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeId, stopLoss, takeProfit })
      });
      const data = await response.json();
      if (data.success) {
        fetchOpenPositions();
      }
    } catch (e) {
      console.error('Failed to update position params:', e);
    }
  };

  const killBot = async () => {
    if (confirm('Are you sure you want to KILL the bot? This will stop the engine and close all positions.')) {
      try {
        setLastCallTime(Date.now());
        await fetch(`${APP_URL}/api/kill`, { method: 'POST' });
        fetchStatus();
        fetchTrades();
        fetchPerformance();
      } catch (e) {
        console.error('Failed to kill bot:', e);
      }
    }
  };

  const changeActiveMode = async (mode: string) => {
    setActiveMode(mode);
    try {
      await fetch(`${APP_URL}/api/active-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
    } catch (e) {
      console.error('Failed to change active mode:', e);
    }
  };

  return (
    <div className="min-h-screen bg-[#121212] text-gray-100 p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Adaptive Trading System</h1>
              <InfoButton text="Shadow Trading runs multiple risk profiles simultaneously in a simulated environment. The 'Active Mode' is what would be executed on your real account. This allows you to compare performance across different risk appetites in real-time." />
            </div>
            <p className="text-gray-400 text-sm mt-1">{status.symbol} • Multi-Regime Shadow Trading</p>
          </div>
          
          <div className="flex items-center gap-4">
            <StatusLight 
              isLive={true} 
              apiName={status.exchange || "CoinMarketCap"} 
              isDataPassing={isDataPassing} 
              lastCallTime={lastCallTime}
            />
            <div className="flex flex-col items-end gap-1">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${getRegimeColor(status.currentRegime)}`}>
                {getRegimeIcon(status.currentRegime)}
                <select 
                  value={status.currentRegime}
                  onChange={async (e) => {
                    const val = e.target.value;
                    await fetch('/api/regime/manual', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ regime: val === 'auto' ? null : val })
                    });
                    if (val === 'auto') {
                      // It will be updated by websocket
                    } else {
                      setStatus(prev => ({ ...prev, currentRegime: val }));
                      setRegimeReasoning('Manually set by user');
                    }
                  }}
                  className="bg-transparent text-sm font-medium uppercase tracking-wider focus:outline-none cursor-pointer"
                >
                  <option value="auto" className="bg-black text-white">AUTO</option>
                  <option value="strong_bull" className="bg-black text-white">STRONG BULL</option>
                  <option value="weak_bull" className="bg-black text-white">WEAK BULL</option>
                  <option value="bear" className="bg-black text-white">BEAR</option>
                  <option value="sideways" className="bg-black text-white">SIDEWAYS</option>
                  <option value="uncertain" className="bg-black text-white">UNCERTAIN</option>
                </select>
              </div>
              {regimeReasoning && (
                <div className="flex items-center gap-1 text-[10px] text-gray-500 italic max-w-[200px] truncate">
                  <Activity size={10} />
                  <span>{regimeReasoning}</span>
                </div>
              )}
            </div>
            
            <button
              onClick={toggleEngine}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                status.isRunning 
                  ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20' 
                  : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20'
              }`}
            >
              {status.isRunning ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              {status.isRunning ? 'Stop Engine' : 'Start Engine'}
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => manualTrade('buy')}
                className="px-4 py-2 rounded-lg bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20 font-medium"
              >
                Enter High
              </button>
              <button
                onClick={() => manualTrade('sell')}
                className="px-4 py-2 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 font-medium"
              >
                Enter Low
              </button>
            </div>
            <button
              onClick={() => setShowSettings(true)}
              className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
            >
              <Settings className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Market Overview Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center">
            <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1">Market Cap</p>
            <p className="text-sm font-mono text-white">
              {marketData ? `$${(marketData.market_cap / 1e12).toFixed(2)}T` : '---'}
            </p>
          </div>
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center">
            <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1">24h Volume</p>
            <p className="text-sm font-mono text-white">
              {marketData ? `$${(marketData.total_volume / 1e9).toFixed(2)}B` : '---'}
            </p>
          </div>
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center">
            <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1">BTC Dominance</p>
            <p className="text-sm font-mono text-white">
              {marketData ? `${marketData.btc_dominance.toFixed(1)}%` : '---'}
            </p>
          </div>
          <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-3 flex flex-col justify-center">
            <div className="flex justify-between items-center mb-1">
              <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Fear & Greed</p>
              {marketData && (
                <span className={`text-[8px] font-bold px-1 rounded ${
                  marketData.fear_greed_index > 70 ? 'bg-emerald-500/20 text-emerald-400' :
                  marketData.fear_greed_index < 30 ? 'bg-red-500/20 text-red-400' :
                  'bg-amber-500/20 text-amber-400'
                }`}>
                  {marketData.fear_greed_value}
                </span>
              )}
            </div>
            <p className="text-sm font-mono text-white">
              {marketData ? marketData.fear_greed_index : '---'}
            </p>
          </div>
          <div className="col-span-2 md:col-span-4 lg:col-span-1 flex items-center gap-2">
            <button
              onClick={refreshMarketData}
              disabled={isRefreshingMarket}
              className="flex-1 h-full bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 py-3 lg:py-0"
            >
              <Activity className={`w-4 h-4 ${isRefreshingMarket ? 'animate-spin' : ''}`} />
              {isRefreshingMarket ? 'Refreshing...' : 'Refresh Market Data'}
            </button>
          </div>
        </div>

        {/* Main Content Grid */}
        <div className={`grid grid-cols-1 lg:grid-cols-3 gap-6 transition-colors duration-300 ${showBacktestUI ? 'bg-amber-950/5' : ''}`}>
          
          {/* Chart Section (Left 2/3) */}
          <div className="lg:col-span-2 space-y-6">
            <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.1)]' : 'border-white/5'} overflow-hidden`}>
              <div className="p-4 border-b border-white/5 flex justify-between items-center">
                <h2 className="font-medium flex items-center gap-2">
                  <Activity className={`w-4 h-4 ${showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`} />
                  {showBacktestUI ? 'Backtest Simulation' : 'Live Market Data'}
                </h2>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setShowBacktestUI(!showBacktestUI)}
                    className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
                      showBacktestUI 
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' 
                        : 'bg-white/5 hover:bg-white/10 text-gray-400 border border-transparent'
                    }`}
                    title="Backtest Mode"
                  >
                    <History className="w-3.5 h-3.5" />
                    Backtest
                  </button>
                  <button 
                    onClick={() => chartRef.current?.timeScale().fitContent()}
                    className="px-2 py-1 text-xs rounded bg-white/5 hover:bg-white/10 text-gray-400 border border-transparent mr-2 flex items-center gap-1 transition-colors"
                    title="Reset Zoom/Pan"
                  >
                    <Maximize2 className="w-3 h-3" />
                  </button>
                  {['1m', '5m', '15m', '1h', '4h'].map(tf => (
                    <button 
                      key={tf} 
                      onClick={() => changeTimeframe(tf)}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        status.timeframe === tf 
                          ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' 
                          : 'bg-white/5 hover:bg-white/10 text-gray-400 border border-transparent'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
              <div className="px-4 py-2 border-b border-white/5 flex gap-2 items-center overflow-x-auto">
                <div className="flex items-center gap-1 mr-2">
                  <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Indicators:</span>
                  <InfoButton text="Technical indicators used to identify market trends and potential entry/exit points." position="left-full ml-1 top-0" />
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setIndicatorToggles(p => ({...p, ema9: !p.ema9}))} className={`px-2 py-1 text-xs font-medium rounded transition-colors ${indicatorToggles.ema9 ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}>EMA 9</button>
                  <InfoButton text="Exponential Moving Average (9 periods). Short-term trend indicator." position="bottom-full mb-2 left-0" />
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setIndicatorToggles(p => ({...p, ema21: !p.ema21}))} className={`px-2 py-1 text-xs font-medium rounded transition-colors ${indicatorToggles.ema21 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}>EMA 21</button>
                  <InfoButton text="Exponential Moving Average (21 periods). Medium-term trend indicator." position="bottom-full mb-2 left-0" />
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setIndicatorToggles(p => ({...p, ema50: !p.ema50}))} className={`px-2 py-1 text-xs font-medium rounded transition-colors ${indicatorToggles.ema50 ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}>EMA 50</button>
                  <InfoButton text="Exponential Moving Average (50 periods). Long-term trend indicator." position="bottom-full mb-2 left-0" />
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setIndicatorToggles(p => ({...p, vwap: !p.vwap}))} className={`px-2 py-1 text-xs font-medium rounded transition-colors ${indicatorToggles.vwap ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}>VWAP</button>
                  <InfoButton text="Volume Weighted Average Price. Benchmark for the average price a security has traded at throughout the day." position="bottom-full mb-2 left-0" />
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setIndicatorToggles(p => ({...p, bb: !p.bb}))} className={`px-2 py-1 text-xs font-medium rounded transition-colors ${indicatorToggles.bb ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}>Bollinger Bands</button>
                  <InfoButton text="Volatility indicator consisting of a middle SMA and two standard deviation bands." position="bottom-full mb-2 left-0" />
                </div>
              </div>

              {showBacktestUI && (
                <div className="px-4 py-3 bg-amber-500/5 border-b border-white/5 flex flex-wrap gap-4 items-center animate-in slide-in-from-top-2 duration-200">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-amber-400" />
                    <span className="text-xs font-medium text-gray-300">Backtest Period:</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input 
                      type="date" 
                      value={backtestDates.start}
                      max={new Date().toISOString().split('T')[0]}
                      onChange={(e) => setBacktestDates({...backtestDates, start: e.target.value})}
                      className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-500"
                    />
                    <span className="text-gray-600">to</span>
                    <input 
                      type="date" 
                      value={backtestDates.end}
                      max={new Date().toISOString().split('T')[0]}
                      onChange={(e) => setBacktestDates({...backtestDates, end: e.target.value})}
                      className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <button 
                    onClick={() => {
                      const start = new Date(backtestDates.start).getTime();
                      const end = new Date(backtestDates.end).getTime() + 24 * 60 * 60 * 1000;
                      runBacktest(start, end);
                    }}
                    disabled={isBacktesting}
                    className="px-4 py-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black text-xs font-bold rounded transition-colors flex items-center gap-2"
                  >
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
                        <p className="text-sm font-mono text-white font-bold">
                          {backtestTrades.length}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="relative w-full min-h-[400px]">
                {isLoadingCandles && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#1e1e1e]/80 backdrop-blur-sm">
                    <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2"></div>
                    <div className="text-indigo-400 font-mono text-sm animate-pulse">Loading 1 Year Historical Data...</div>
                  </div>
                )}
                <div ref={chartContainerRef} className="w-full h-[400px]" />
                <div 
                  ref={legendRef} 
                  className="absolute top-3 left-3 z-10 pointer-events-none text-xs font-mono bg-[#1e1e1e]/80 p-2 rounded border border-white/10 backdrop-blur-sm flex-col gap-1 shadow-lg"
                  style={{ display: 'none' }}
                >
                </div>
              </div>
            </div>

            {/* Shadow Comparison */}
            <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30' : 'border-white/5'} p-4`}>
              <h2 className={`font-medium mb-4 ${showBacktestUI ? 'text-amber-400' : ''}`}>
                {showBacktestUI ? 'Backtest Performance Comparison' : 'Shadow Portfolio Comparison'}
              </h2>

              {/* Performance Chart */}
              <div className="h-[180px] w-full mb-6">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performance[activeMode]?.history || []}>
                    <defs>
                      <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={showBacktestUI ? "#f59e0b" : "#6366f1"} stopOpacity={0.3}/>
                        <stop offset="95%" stopColor={showBacktestUI ? "#f59e0b" : "#6366f1"} stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                    <XAxis 
                      dataKey="time" 
                      hide 
                    />
                    <YAxis 
                      domain={['auto', 'auto']} 
                      hide 
                    />
                    <Tooltip 
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="bg-[#1e1e1e] border border-white/10 p-2 rounded shadow-xl text-[10px] font-mono">
                              <p className="text-gray-400">{new Date(payload[0].payload.time).toLocaleString()}</p>
                              <p className={showBacktestUI ? "text-amber-400" : "text-indigo-400"}>
                                Balance: ${payload[0].value.toFixed(2)}
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="balance" 
                      stroke={showBacktestUI ? "#f59e0b" : "#6366f1"} 
                      fillOpacity={1} 
                      fill="url(#colorBalance)" 
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
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
                      <tr 
                        key={mode} 
                        className={`border-b border-white/5 cursor-pointer transition-colors ${
                          activeMode === mode 
                            ? (showBacktestUI ? 'bg-amber-500/10' : 'bg-indigo-500/10') 
                            : (showBacktestUI ? 'hover:bg-amber-500/5' : 'hover:bg-white/5')
                        }`}
                        onClick={() => setActiveMode(mode)}
                      >
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
          </div>

          {/* Sidebar (Right 1/3) */}
          <div className="space-y-6">
            {/* Balance Management */}
            <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.05)]' : 'border-white/5'} p-4`}>
              <div className="flex justify-between items-center mb-4">
                <h2 className={`font-medium ${showBacktestUI ? 'text-amber-400' : 'text-gray-300'}`}>
                  {showBacktestUI ? 'Simulated Balance' : 'Balance Management'}
                </h2>
                <button 
                  onClick={killBot}
                  className="text-[10px] px-2 py-1 bg-red-500/10 text-red-500 border border-red-500/20 rounded hover:bg-red-500/20 transition-colors font-bold uppercase"
                >
                  Kill Bot
                </button>
              </div>
              
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-black/20 p-2 rounded-lg border border-white/5">
                    <p className="text-[10px] text-gray-500 uppercase font-semibold">Main Balance</p>
                    <p className="text-sm font-mono text-white">${balances.mainBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>
                  <div className="bg-black/20 p-2 rounded-lg border border-white/5">
                    <p className={`text-[10px] uppercase font-semibold ${showBacktestUI ? 'text-amber-500/60' : 'text-gray-500'}`}>Bot Balance</p>
                    <p className={`text-sm font-mono ${showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`}>${balances.botBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className={`bg-black/20 p-2 rounded-lg border ${showBacktestUI ? 'border-amber-500/10' : 'border-white/5'}`}>
                    <p className={`text-[10px] uppercase font-semibold ${showBacktestUI ? 'text-amber-500/60' : 'text-gray-500'}`}>Active Trade</p>
                    <p className="text-sm font-mono text-amber-400">${balances.activeTradeBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>
                  <div className={`bg-black/20 p-2 rounded-lg border ${showBacktestUI ? 'border-amber-500/10' : 'border-white/5'}`}>
                    <p className={`text-[10px] uppercase font-semibold ${showBacktestUI ? 'text-amber-500/60' : 'text-gray-500'}`}>Profit/Loss</p>
                    <div className="flex items-center gap-1">
                      <p className={`text-sm font-mono ${balances.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {balances.totalPnl >= 0 ? '+' : ''}{balances.totalPnl.toFixed(2)}
                      </p>
                      <span className={`text-[10px] ${balances.totalPnlPct >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        ({balances.totalPnlPct.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button 
                    onClick={() => {
                      setBalanceModalType('allocate');
                      setBalanceAmount('');
                      setShowBalanceModal(true);
                    }}
                    className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors"
                  >
                    + Allocate
                  </button>
                  <button 
                    onClick={() => {
                      setBalanceModalType('withdraw');
                      setBalanceAmount('');
                      setShowBalanceModal(true);
                    }}
                    className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors"
                  >
                    - Withdraw
                  </button>
                </div>

                <div className="flex gap-2">
                  <button 
                    onClick={halfBalance}
                    className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors"
                  >
                    1/2 Balance
                  </button>
                  <button 
                    onClick={doubleBalance}
                    className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors"
                  >
                    x2 Balance
                  </button>
                </div>
              </div>
            </div>

            {/* Active Mode Stats */}
            <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30' : 'border-white/5'} p-4`}>
              <div className="flex justify-between items-center mb-4">
                <div className="flex flex-col">
                  <h2 className={`font-medium capitalize ${showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`}>{activeMode.replace('_', ' ')} Mode</h2>
                  <select 
                    value={activeMode}
                    onChange={(e) => changeActiveMode(e.target.value)}
                    className="mt-1 bg-transparent text-[10px] text-gray-500 focus:outline-none cursor-pointer hover:text-gray-300"
                  >
                    {Object.values(RiskMode).map(mode => (
                      <option key={mode} value={mode} className="bg-[#1e1e1e]">{mode.replace('_', ' ')}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2 relative">
                  <button 
                    onClick={() => setShowConfigModal(!showConfigModal)} 
                    className={`text-xs px-2 py-1 rounded transition-colors ${
                      showConfigModal 
                        ? (showBacktestUI ? 'bg-amber-500 text-black' : 'bg-indigo-500 text-white') 
                        : 'bg-white/5 hover:bg-white/10 text-gray-300'
                    }`}
                  >
                    Configure
                  </button>
                  <span className={`text-xs px-2 py-1 rounded ${showBacktestUI ? 'bg-amber-500/20 text-amber-300' : 'bg-indigo-500/20 text-indigo-300'}`}>
                    {showBacktestUI ? 'Simulated' : 'Active'}
                  </span>

                  {/* Strategy Config Dropdown */}
                  {showConfigModal && riskConfigs[activeMode] && (
                    <div className={`absolute top-full right-0 mt-2 w-80 bg-[#1e1e1e] border rounded-xl shadow-2xl z-50 p-4 animate-in fade-in slide-in-from-top-2 duration-200 ${showBacktestUI ? 'border-amber-500/20 shadow-amber-500/5' : 'border-white/10 shadow-black/50'}`}>
                      <div className="flex justify-between items-center mb-4">
                        <div className="flex items-center gap-2">
                          <h2 className={`text-sm font-bold capitalize ${showBacktestUI ? 'text-amber-400' : ''}`}>{activeMode.replace('_', ' ')} Strategy</h2>
                          <InfoButton text={`Parameters for ${activeMode}: Risk per trade, Leverage, Take Profit and Stop Loss multipliers are adjusted to match this risk profile.`} />
                        </div>
                        <button onClick={() => setShowConfigModal(false)} className="text-gray-400 hover:text-white">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      
                      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1 custom-scrollbar">
                        <div className={`p-2 rounded-lg text-[11px] leading-relaxed ${showBacktestUI ? 'bg-amber-500/10 border border-amber-500/20 text-amber-200' : 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-200'}`}>
                          {riskConfigs[activeMode].description}
                        </div>

                        {isBacktesting ? (
                          <div className="bg-black/20 p-3 rounded-lg border border-white/5 flex items-center justify-center gap-2">
                            <Activity className={`w-3 h-3 animate-pulse ${showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`} />
                            <span className="text-[11px] text-gray-400">Backtesting...</span>
                          </div>
                        ) : backtestTrades.length > 0 && (
                          <div className={`bg-black/20 p-2 rounded-lg border ${showBacktestUI ? 'border-amber-500/20' : 'border-white/5'}`}>
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Backtest Results</span>
                              <span className={`text-[10px] ${showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`}>{backtestTrades.length} Trades</span>
                            </div>
                            <div className="grid grid-cols-3 gap-1 text-center">
                              <div>
                                <p className="text-[9px] text-gray-500">Win Rate</p>
                                <p className="text-[11px] font-mono text-white">
                                  {backtestTrades.length > 0 ? (backtestTrades.filter(t => t.status === 'profit').length / backtestTrades.length * 100).toFixed(1) : '0.0'}%
                                </p>
                              </div>
                              <div>
                                <p className="text-[9px] text-gray-500">Avg PnL</p>
                                <p className={`text-[11px] font-mono ${(backtestTrades.reduce((acc, t) => acc + t.pnl, 0) / (backtestTrades.length || 1)) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {backtestTrades.length > 0 ? (backtestTrades.reduce((acc, t) => acc + t.pnl, 0) / backtestTrades.length).toFixed(2) : '0.00'}%
                                </p>
                              </div>
                              <div>
                                <p className="text-[9px] text-gray-500">Total PnL</p>
                                <p className={`text-[11px] font-mono ${backtestTrades.reduce((acc, t) => acc + t.pnl, 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {backtestTrades.reduce((acc, t) => acc + t.pnl, 0).toFixed(2)}%
                                </p>
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[10px] font-medium text-gray-400 mb-1">TP Multiplier</label>
                              <input 
                                type="number" 
                                step="0.1"
                                value={riskConfigs[activeMode].tpMultiplier || 0}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  setRiskConfigs({
                                    ...riskConfigs,
                                    [activeMode]: { ...riskConfigs[activeMode], tpMultiplier: isNaN(val) ? 0 : val }
                                  });
                                }}
                                className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-gray-400 mb-1">SL Multiplier</label>
                              <input 
                                type="number" 
                                step="0.1"
                                value={riskConfigs[activeMode].slMultiplier || 0}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  setRiskConfigs({
                                    ...riskConfigs,
                                    [activeMode]: { ...riskConfigs[activeMode], slMultiplier: isNaN(val) ? 0 : val }
                                  });
                                }}
                                className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[10px] font-medium text-gray-400 mb-1">Leverage (x)</label>
                              <input 
                                type="number" 
                                step="0.01"
                                min="0"
                                max="500"
                                value={riskConfigs[activeMode].leverage || 1}
                                onChange={(e) => {
                                  let val = parseFloat(e.target.value);
                                  if (isNaN(val)) val = 1;
                                  if (val < 0) val = 0;
                                  if (val > 500) val = 500;
                                  setRiskConfigs({
                                    ...riskConfigs,
                                    [activeMode]: { ...riskConfigs[activeMode], leverage: val }
                                  });
                                }}
                                className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-gray-400 mb-1">Risk/Trade (%)</label>
                              <input 
                                type="number" 
                                step="0.1"
                                value={(riskConfigs[activeMode].maxRiskPerTrade * 100) || 0}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  setRiskConfigs({
                                    ...riskConfigs,
                                    [activeMode]: { ...riskConfigs[activeMode], maxRiskPerTrade: isNaN(val) ? 0 : val / 100 }
                                  });
                                }}
                                className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-gray-400 mb-1">Max DD (%)</label>
                              <input 
                                type="number" 
                                step="0.1"
                                value={(riskConfigs[activeMode].maxDrawdown * 100) || 0}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  setRiskConfigs({
                                    ...riskConfigs,
                                    [activeMode]: { ...riskConfigs[activeMode], maxDrawdown: isNaN(val) ? 0 : val / 100 }
                                  });
                                }}
                                className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[10px] font-medium text-gray-400 mb-1">Conf. Threshold</label>
                              <input 
                                type="number" 
                                value={riskConfigs[activeMode].confidenceThreshold || 0}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setRiskConfigs({
                                    ...riskConfigs,
                                    [activeMode]: { ...riskConfigs[activeMode], confidenceThreshold: isNaN(val) ? 0 : val }
                                  });
                                }}
                                className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-gray-400 mb-1">Max Positions</label>
                              <input 
                                type="number" 
                                value={riskConfigs[activeMode].maxConcurrentPositions || 0}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setRiskConfigs({
                                    ...riskConfigs,
                                    [activeMode]: { ...riskConfigs[activeMode], maxConcurrentPositions: isNaN(val) ? 0 : val }
                                  });
                                }}
                                className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex gap-2 pt-2">
                          <button 
                            onClick={getAiRecommendations}
                            className="flex-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 py-1.5 rounded text-[10px] font-medium transition-colors"
                          >
                            AI Recommend
                          </button>
                          <button 
                            onClick={resetRiskConfigs}
                            className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium transition-colors"
                          >
                            Reset
                          </button>
                        </div>
                        
                        <button 
                          onClick={saveRiskConfigs}
                          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2 rounded text-xs font-medium transition-colors"
                        >
                          Save Configuration
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className={`p-3 rounded-lg bg-black/20 border ${showBacktestUI ? 'border-amber-500/10' : 'border-white/5'}`}>
                  <p className="text-xs text-gray-400 mb-1">Total P&L</p>
                  <p className={`text-lg font-mono ${(showBacktestUI ? backtestTrades.reduce((acc, t) => acc + t.pnl, 0) : (performance[activeMode]?.totalPnl || 0)) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {showBacktestUI ? '' : '$'}{(showBacktestUI ? backtestTrades.reduce((acc, t) => acc + t.pnl, 0) : (performance[activeMode]?.totalPnl || 0)).toFixed(2)}{showBacktestUI ? '%' : ''}
                  </p>
                </div>
                <div className={`p-3 rounded-lg bg-black/20 border ${showBacktestUI ? 'border-amber-500/10' : 'border-white/5'}`}>
                  <p className="text-xs text-gray-400 mb-1">Win Rate</p>
                  <p className="text-lg font-mono text-white">
                    {(showBacktestUI ? (backtestTrades.length > 0 ? (backtestTrades.filter(t => t.status === 'profit').length / backtestTrades.length * 100) : 0) : (performance[activeMode]?.winRate || 0)).toFixed(1)}%
                  </p>
                </div>
              </div>
            </div>

            {/* Open Positions */}
            {!showBacktestUI && (
              <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-4">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="font-medium text-indigo-400 flex items-center gap-2">
                    <Activity className="w-4 h-4" />
                    Open Positions
                  </h2>
                  <div className="text-right">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Total Value</p>
                    <p className="text-xs font-mono text-white">
                      ${openPositions.reduce((acc: number, pos: any) => acc + (pos.amount * currentPrice), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                </div>
                
                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  {openPositions.map((pos: any, i: number) => {
                    const pnl = (currentPrice - pos.price) * pos.amount * (pos.side === 'buy' ? 1 : -1);
                    const pnlPct = (pnl / (pos.amount * pos.price / pos.leverage)) * 100;
                    const isEditing = editingPosition === pos.id;

                    return (
                      <div key={pos.id || i} className="p-3 rounded-lg bg-black/20 border border-white/5 hover:border-white/10 transition-colors">
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${pos.side === 'buy' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                              {pos.side}
                            </span>
                            <span className="text-xs font-mono text-white">{pos.symbol}</span>
                            <span className="text-[10px] bg-white/5 px-1.5 py-0.5 rounded text-gray-400 border border-white/5">
                              {pos.leverage}x
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button 
                              onClick={() => {
                                if (isEditing) {
                                  setEditingPosition(null);
                                } else {
                                  setEditingPosition(pos.id);
                                  setEditSl(pos.stopLoss);
                                  setEditTp(pos.takeProfit);
                                }
                              }}
                              className="p-1 hover:bg-white/5 rounded transition-colors text-gray-500 hover:text-white"
                              title="Edit TP/SL"
                            >
                              <Settings className="w-3 h-3" />
                            </button>
                            <button 
                              onClick={() => closePosition(pos.id)}
                              className="p-1 hover:bg-red-500/20 rounded transition-colors text-gray-500 hover:text-red-400"
                              title="Close Position"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>

                        {isEditing ? (
                          <div className="mt-2 p-2 bg-black/40 rounded border border-indigo-500/30 space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[8px] text-gray-500 uppercase block mb-1">Stop Loss</label>
                                <input 
                                  type="number" 
                                  value={editSl}
                                  onChange={(e) => setEditSl(Number(e.target.value))}
                                  className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:border-indigo-500 outline-none"
                                />
                              </div>
                              <div>
                                <label className="text-[8px] text-gray-500 uppercase block mb-1">Take Profit</label>
                                <input 
                                  type="number" 
                                  value={editTp}
                                  onChange={(e) => setEditTp(Number(e.target.value))}
                                  className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:border-indigo-500 outline-none"
                                />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button 
                                onClick={() => {
                                  updatePositionParams(pos.id, editSl, editTp);
                                  setEditingPosition(null);
                                }}
                                className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] py-1 rounded transition-colors"
                              >
                                Save
                              </button>
                              <button 
                                onClick={() => setEditingPosition(null)}
                                className="flex-1 bg-white/5 hover:bg-white/10 text-gray-400 text-[10px] py-1 rounded transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-2 text-[10px]">
                            <div>
                              <p className="text-gray-500">Entry: <span className="text-gray-300">${pos.price.toFixed(2)}</span></p>
                              <p className="text-gray-500">Amount: <span className="text-gray-300">{pos.amount.toFixed(4)}</span></p>
                              <div className="flex gap-2 mt-1">
                                <span className="text-[8px] text-red-400/60">SL: ${pos.stopLoss?.toFixed(2)}</span>
                                <span className="text-[8px] text-emerald-400/60">TP: ${pos.takeProfit?.toFixed(2)}</span>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className={`font-mono text-sm ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                              </p>
                              <p className={`font-mono text-[10px] ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                              </p>
                              <p className="text-[8px] text-gray-600 mt-1">{pos.risk_mode.replace('_', ' ')}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {openPositions.length === 0 && (
                    <div className="text-center py-4">
                      <p className="text-xs text-gray-600 italic">No open positions</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Recent Signals */}
            <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.05)]' : 'border-white/5'} p-4`}>
              <h2 className={`font-medium mb-4 ${showBacktestUI ? 'text-amber-400' : 'text-gray-300'}`}>
                {showBacktestUI ? 'Simulated Signals' : 'Recent Signals'}
              </h2>
              <div className="space-y-3">
                {(showBacktestUI ? backtestTrades.slice(-5).reverse() : trades.slice(0, 5)).map((trade: any, i: number) => (
                  <div key={i} className={`p-3 rounded-lg bg-black/20 border transition-colors ${showBacktestUI ? 'border-amber-500/10 hover:border-amber-500/30' : 'border-white/5 hover:border-white/10'}`}>
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${trade.side === 'buy' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                          {trade.side}
                        </span>
                        <span className="text-xs font-mono text-white">{trade.symbol}</span>
                      </div>
                      <span className="text-[10px] text-gray-500">{new Date(trade.timestamp || trade.time).toLocaleTimeString()}</span>
                    </div>
                    <div className="flex justify-between text-[10px]">
                      <span className="text-gray-500">Price: <span className="text-gray-300">${(trade.price || trade.entryPrice).toFixed(2)}</span></span>
                      {trade.pnl !== undefined && trade.pnl !== null && (
                        <span className={`font-mono ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {trade.pnl > 0 ? '+' : ''}{trade.pnl.toFixed(2)}%
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {((showBacktestUI ? backtestTrades : trades).length === 0) && (
                  <div className="text-center py-8">
                    <p className="text-xs text-gray-600 italic">No signals detected yet</p>
                  </div>
                )}
              </div>
            </div>

            {/* Recent Trades */}
            <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.05)]' : 'border-white/5'} p-4 flex-1`}>
              <h2 className={`font-medium mb-4 ${showBacktestUI ? 'text-amber-400' : ''}`}>
                {showBacktestUI ? `Backtest Trades (${activeMode})` : `Recent Trades (${activeMode})`}
              </h2>
              <div className="space-y-3">
                {(showBacktestUI ? backtestTrades.slice(-5).reverse() : trades.filter(t => t.risk_mode === activeMode).slice(0, 5)).map((trade: any, i: number) => (
                  <div key={trade.id || i} className={`flex justify-between items-center p-3 rounded-lg bg-black/20 text-sm border ${showBacktestUI ? 'border-amber-500/10' : 'border-white/5'}`}>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`font-bold ${trade.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {trade.side.toUpperCase()}
                        </span>
                        <span>{trade.symbol}</span>
                        {trade.leverage && (
                          <span className="text-[10px] bg-white/5 px-1.5 py-0.5 rounded text-gray-400 border border-white/5">
                            {trade.leverage}x
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {new Date(trade.timestamp || trade.time).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono">${(trade.price || trade.entryPrice).toFixed(2)}</div>
                      {(trade.status === 'closed' || trade.exitTime) ? (
                        <div className={`text-xs font-mono mt-1 ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}%
                        </div>
                      ) : (
                        <div className="text-xs text-indigo-400 mt-1">OPEN</div>
                      )}
                    </div>
                  </div>
                ))}
                {((showBacktestUI ? backtestTrades : trades.filter(t => t.risk_mode === activeMode)).length === 0) && (
                  <div className="text-center text-gray-500 py-4 text-sm">No recent trades</div>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div 
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowSettings(false)}
        >
          <div 
            className="bg-[#1e1e1e] border border-white/10 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-4 border-b border-white/5 flex-shrink-0">
              <h2 className="text-xl font-bold">System Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Trading Pair</label>
                <select 
                  value={settings.symbol}
                  onChange={(e) => setSettings({ ...settings, symbol: e.target.value })}
                  className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="BTC/USDT">BTC/USDT</option>
                  <option value="ETH/USDT">ETH/USDT</option>
                  <option value="SOL/USDT">SOL/USDT</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Timeframe</label>
                <select 
                  value={settings.timeframe}
                  onChange={(e) => setSettings({ ...settings, timeframe: e.target.value })}
                  className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="1h">1h</option>
                  <option value="4h">4h</option>
                </select>
              </div>

              <div className="pt-4 border-t border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-300">AI Strategy Switching</label>
                    <p className="text-xs text-gray-500 mt-1">Automatically switch modes based on market trend</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer" 
                      checked={settings.aiStrategySwitching === 'true'}
                      onChange={(e) => setSettings({ ...settings, aiStrategySwitching: e.target.checked ? 'true' : 'false' })}
                    />
                    <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                  </label>
                </div>
              </div>

              <div className="pt-4 border-t border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-amber-400">AI Signal Generation</label>
                    <p className="text-xs text-gray-500 mt-1">Use Gemini to confirm technical trade signals</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer" 
                      checked={settings.aiSignalGeneration === 'true'}
                      onChange={(e) => setSettings({ ...settings, aiSignalGeneration: e.target.checked ? 'true' : 'false' })}
                    />
                    <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                  </label>
                </div>
              </div>

              <div className="pt-4 border-t border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-amber-400">AI Sentiment Analysis</label>
                    <p className="text-xs text-gray-500 mt-1">Use Gemini to gauge market sentiment for regime detection</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer" 
                      checked={settings.aiSentimentAnalysis === 'true'}
                      onChange={(e) => setSettings({ ...settings, aiSentimentAnalysis: e.target.checked ? 'true' : 'false' })}
                    />
                    <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                  </label>
                </div>
              </div>

              <div className="pt-4 border-t border-white/5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-300">Market Data Provider</h3>
                  <a 
                    href={getProviderDocsUrl(settings.exchange)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    Docs
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Exchange/Provider</label>
                    <select
                      value={settings.exchange}
                      onChange={(e) => setSettings({ ...settings, exchange: e.target.value })}
                      className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                    >
                      <option value="coinmarketcap">CoinMarketCap</option>
                      <option value="coingecko">CoinGecko</option>
                      <option value="cryptocompare">CryptoCompare</option>
                      <option value="binance">Binance</option>
                      <option value="kraken">Kraken</option>
                      <option value="okx">OKX</option>
                      <option value="coinbase">Coinbase</option>
                    </select>
                  </div>

                  {settings.exchange === 'coinmarketcap' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">CoinMarketCap API Key</label>
                      <input
                        type="password"
                        value={settings.apiKey}
                        onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                        placeholder="Enter your CoinMarketCap Pro API key"
                        className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                      />
                      <p className="text-xs text-gray-500 mt-1">Requires Pro plan for historical OHLCV data. Get your key at <a href="https://pro.coinmarketcap.com" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">pro.coinmarketcap.com</a></p>
                    </div>
                  )}

                  {settings.exchange === 'coingecko' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">CoinGecko API Key (Optional)</label>
                      <input
                        type="password"
                        value={settings.apiKey}
                        onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                        placeholder="Enter your CoinGecko API key"
                        className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                      />
                      <p className="text-xs text-gray-500 mt-1">Free tier available. Get your key at <a href="https://www.coingecko.com/en/api" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">coingecko.com/en/api</a></p>
                    </div>
                  )}

                  {settings.exchange === 'cryptocompare' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">CryptoCompare API Key</label>
                      <input
                        type="password"
                        value={settings.apiKey}
                        onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                        placeholder="Enter your CryptoCompare API key"
                        className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                      />
                      <p className="text-xs text-gray-500 mt-1">Get your key at <a href="https://min-api.cryptocompare.com" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">min-api.cryptocompare.com</a></p>
                    </div>
                  )}

                  {(settings.exchange === 'binance' || settings.exchange === 'kraken' || settings.exchange === 'okx' || settings.exchange === 'coinbase') && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-gray-400 mb-1">API Key</label>
                        <input
                          type="password"
                          value={settings.apiKey}
                          onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                          placeholder={`Enter your ${settings.exchange} API key`}
                          className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-400 mb-1">API Secret</label>
                        <input
                          type="password"
                          value={settings.apiSecret}
                          onChange={(e) => setSettings({ ...settings, apiSecret: e.target.value })}
                          placeholder={`Enter your ${settings.exchange} API secret`}
                          className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                        />
                      </div>
                      {settings.exchange === 'coinbase' && (
                        <div>
                          <label className="block text-xs font-medium text-gray-400 mb-1">API Passphrase</label>
                          <input
                            type="password"
                            value={settings.apiPassword || ''}
                            onChange={(e) => setSettings({ ...settings, apiPassword: e.target.value })}
                            placeholder="Enter your Coinbase API passphrase"
                            className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="pt-4 border-t border-white/5">
                <h3 className="text-sm font-medium text-gray-300 mb-3">System Configuration</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Base URL</label>
                    <input
                      type="text"
                      value={settings.baseUrl}
                      onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
                      placeholder="https://api.example.com"
                      className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">WebSocket URL</label>
                    <input
                      type="text"
                      value={settings.wsUrl}
                      onChange={(e) => setSettings({ ...settings, wsUrl: e.target.value })}
                      placeholder="wss://ws.example.com"
                      className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">System JSON Config</label>
                    <textarea
                      value={settings.systemJsonConfig}
                      onChange={(e) => setSettings({ ...settings, systemJsonConfig: e.target.value })}
                      placeholder='{"key": "value"}'
                      className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm font-mono h-24"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-white/5">
                <h3 className="text-sm font-medium text-gray-300 mb-3">Strategy Settings</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Trading Strategy</label>
                    <select 
                      value={settings.strategy}
                      onChange={(e) => setSettings({ ...settings, strategy: e.target.value })}
                      className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
                    >
                      <option value="regime">Regime Based</option>
                      <option value="shotgun">Shotgun</option>
                      <option value="alt_chaser">Alt Chaser</option>
                      <option value="chasing_dragons">Chasing Dragons</option>
                    </select>
                  </div>
                  {settings.strategy === 'shotgun' && (
                    <div className="grid grid-cols-2 gap-2">
                       <input type="number" value={settings.shotgunTimeBefore} onChange={(e) => setSettings({...settings, shotgunTimeBefore: e.target.value})} placeholder="Time Before (s)" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white"/>
                       <input type="number" value={settings.shotgunTimeAfter} onChange={(e) => setSettings({...settings, shotgunTimeAfter: e.target.value})} placeholder="Time After (s)" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white"/>
                    </div>
                  )}
                  {settings.strategy === 'alt_chaser' && (
                    <input type="number" value={settings.altChaserPercentage} onChange={(e) => setSettings({...settings, altChaserPercentage: e.target.value})} placeholder="Percentage Change" className="w-full bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white"/>
                  )}
                  {settings.strategy === 'chasing_dragons' && (
                    <div className="grid grid-cols-2 gap-2">
                       <input type="number" value={settings.chasingDragonsLeverage} onChange={(e) => setSettings({...settings, chasingDragonsLeverage: e.target.value})} placeholder="Leverage" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white"/>
                       <input type="number" value={settings.chasingDragonsStopLoss} onChange={(e) => setSettings({...settings, chasingDragonsStopLoss: e.target.value})} placeholder="Stop Loss %" className="bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-white"/>
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-2">
                    <label className="text-sm font-medium text-gray-400">Use Testnet</label>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        className="sr-only peer" 
                        checked={settings.testnet === 'true'}
                        onChange={(e) => setSettings({ ...settings, testnet: e.target.checked ? 'true' : 'false' })}
                      />
                      <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                    </label>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-white/5 flex-shrink-0">
              <button 
                onClick={saveSettings}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Balance Modal */}
      {showBalanceModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#1e1e1e] w-full max-w-md rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 border-b border-white/5 flex justify-between items-center">
              <h2 className="text-xl font-bold capitalize">{balanceModalType} Funds</h2>
              <button onClick={() => setShowBalanceModal(false)} className="text-gray-400 hover:text-white transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="p-6 space-y-6">
              {/* Balance Overview */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-black/20 p-4 rounded-xl border border-white/5">
                  <p className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Main Balance</p>
                  <p className="text-lg font-mono text-white">${balances.mainBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                </div>
                <div className="bg-black/20 p-4 rounded-xl border border-white/5">
                  <p className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Bot Balance</p>
                  <p className="text-lg font-mono text-indigo-400">${balances.botBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-400">Amount to {balanceModalType}</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-mono">$</span>
                  <input 
                    type="number" 
                    autoFocus
                    value={balanceAmount}
                    onChange={(e) => setBalanceAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-black/40 border border-white/10 rounded-xl pl-8 pr-4 py-3 text-lg font-mono focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <div className="flex gap-2">
                  {[0.25, 0.5, 0.75, 1].map(pct => (
                    <button 
                      key={pct}
                      onClick={() => {
                        const max = balanceModalType === 'allocate' ? balances.mainBalance : balances.botBalance;
                        setBalanceAmount((max * pct).toFixed(2));
                      }}
                      className="flex-1 py-1 text-[10px] rounded bg-white/5 hover:bg-white/10 text-gray-400 border border-white/5 transition-colors"
                    >
                      {pct * 100}%
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-6 bg-black/20 border-t border-white/5 flex gap-3">
              <button 
                onClick={() => setShowBalanceModal(false)}
                className="flex-1 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  const amount = parseFloat(balanceAmount);
                  if (amount > 0) {
                    if (balanceModalType === 'allocate') {
                      allocateBalance(amount);
                    } else {
                      withdrawBalance(amount);
                    }
                    setShowBalanceModal(false);
                  }
                }}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  balanceModalType === 'allocate' 
                    ? 'bg-emerald-500 hover:bg-emerald-600 text-white' 
                    : 'bg-indigo-500 hover:bg-indigo-600 text-white'
                }`}
              >
                Confirm {balanceModalType}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Strategy Config Modal - REMOVED and moved to dropdown */}
    </div>
  );
}
