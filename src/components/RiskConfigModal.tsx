/**
 * RiskConfigModal — per-mode risk parameters, /api/risk-configs CRUD,
 * and AI recommend action.
 *
 * Extracted from App() (originally lines ~2376-2625 for the Active Mode Stats
 * card with the config dropdown, plus saveRiskConfigs/resetRiskConfigs/
 * getAiRecommendations at lines ~902-962).
 *
 * Props: data in (activeMode, riskConfigs, showBacktestUI, isBacktesting,
 * backtestTrades, performance), callbacks out (onSaveRiskConfigs,
 * onResetRiskConfigs, onGetAiRecommendations, onChangeActiveMode).
 */
import React from 'react';
import { Activity, X } from 'lucide-react';

enum RiskMode {
  ULTRA_CONSERVATIVE = "ultra_conservative",
  CONSERVATIVE = "conservative",
  MODERATE = "moderate",
  AGGRESSIVE = "aggressive",
  DEGEN = "degen"
}

const InfoButton = ({ text, position = "left-full ml-2 top-0" }: { text: string, position?: string }) => (
  <button type="button" aria-label={text} aria-describedby="info-tooltip"
    className="info-container relative inline-flex items-center justify-center ml-1 rounded focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus-visible:ring-offset-[#1e1e1e] focus-visible:outline-none cursor-help text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors">
    <span id="info-tooltip" className="sr-only">{text}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    <div className={`info-tooltip ${position}`}>{text}</div>
  </button>
);

interface RiskConfigModalProps {
  activeMode: string;
  riskConfigs: Record<string, any>;
  showBacktestUI: boolean;
  isBacktesting: boolean;
  backtestTrades: any[];
  performance: any;
  showConfigModal: boolean;
  onToggleConfigModal: () => void;
  onRiskConfigsChange: (configs: Record<string, any>) => void;
  onSaveRiskConfigs: () => void;
  onResetRiskConfigs: () => void;
  onGetAiRecommendations: () => void;
  onChangeActiveMode: (mode: string) => void;
}

export default function RiskConfigModal(props: RiskConfigModalProps) {
  const {
    activeMode, riskConfigs, showBacktestUI, isBacktesting, backtestTrades,
    performance, showConfigModal, onToggleConfigModal, onRiskConfigsChange,
    onSaveRiskConfigs, onResetRiskConfigs, onGetAiRecommendations, onChangeActiveMode,
  } = props;

  return (
    <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30' : 'border-white/5'} p-4`}>
      <div className="flex justify-between items-center mb-4">
        <div className="flex flex-col">
          <h2 className={`font-medium capitalize ${showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`}>{activeMode.replace('_', ' ')} Mode</h2>
          <select value={activeMode} onChange={(e) => onChangeActiveMode(e.target.value)}
            className="mt-1 bg-[#1e1e1e] text-gray-300 text-[10px] cursor-pointer hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none">
            {Object.values(RiskMode).map(mode => (
              <option key={mode} value={mode} className="bg-[#1e1e1e]">{mode.replace('_', ' ')}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 relative">
          <button onClick={onToggleConfigModal}
            className={`text-xs px-2 py-1 rounded transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none ${
              showConfigModal ? (showBacktestUI ? 'bg-amber-500 text-black' : 'bg-indigo-500 text-white') : 'bg-white/5 hover:bg-white/10 text-gray-300'}`}>
            Configure
          </button>
          <span className={`text-xs px-2 py-1 rounded ${showBacktestUI ? 'bg-amber-500/20 text-amber-300' : 'bg-indigo-500/20 text-indigo-300'}`}>
            {showBacktestUI ? 'Simulated' : 'Active'}
          </span>

          {showConfigModal && riskConfigs[activeMode] && (
            <div className={`absolute top-full right-0 mt-2 w-80 bg-[#1e1e1e] border rounded-xl shadow-2xl z-50 p-4 animate-in fade-in slide-in-from-top-2 duration-200 ${showBacktestUI ? 'border-amber-500/20 shadow-amber-500/5' : 'border-white/10 shadow-black/50'}`}>
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <h2 className={`text-sm font-bold capitalize ${showBacktestUI ? 'text-amber-400' : ''}`}>{activeMode.replace('_', ' ')} Strategy</h2>
                  <InfoButton text={`Parameters for ${activeMode}: Risk per trade, Leverage, Take Profit and Stop Loss multipliers are adjusted to match this risk profile.`} />
                </div>
                <button onClick={onToggleConfigModal} className="text-gray-400 hover:text-white focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none" aria-label="Close strategy config">
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
                        <p className="text-[11px] font-mono text-white">{backtestTrades.length > 0 ? (backtestTrades.filter(t => t.status === 'profit').length / backtestTrades.length * 100).toFixed(1) : '0.0'}%</p>
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
                      <input type="number" step="0.1" value={riskConfigs[activeMode].takeProfit ?? 1.5}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          onRiskConfigsChange({ ...riskConfigs, [activeMode]: { ...riskConfigs[activeMode], takeProfit: isNaN(val) ? 0 : val } });
                        }}
                        className="w-full bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-gray-400 mb-1">SL Multiplier</label>
                      <input type="number" step="0.1" value={riskConfigs[activeMode].stopLoss ?? 2.5}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          onRiskConfigsChange({ ...riskConfigs, [activeMode]: { ...riskConfigs[activeMode], stopLoss: isNaN(val) ? 0 : val } });
                        }}
                        className="w-full bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium text-gray-400 mb-1">Leverage (x)</label>
                      <input type="number" step="0.01" min="0" max="500" value={riskConfigs[activeMode].leverage || 1}
                        onChange={(e) => {
                          let val = parseFloat(e.target.value);
                          if (isNaN(val)) val = 1;
                          if (val < 0) val = 0;
                          if (val > 500) val = 500;
                          onRiskConfigsChange({ ...riskConfigs, [activeMode]: { ...riskConfigs[activeMode], leverage: val } });
                        }}
                        className="w-full bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-gray-400 mb-1">Risk/Trade (%)</label>
                      <input type="number" step="0.1" value={((riskConfigs[activeMode].positionSize ?? 0.05) * 100)}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          onRiskConfigsChange({ ...riskConfigs, [activeMode]: { ...riskConfigs[activeMode], positionSize: isNaN(val) ? 0 : val / 100 } });
                        }}
                        className="w-full bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-gray-400 mb-1">Max DD (%)</label>
                      <input type="number" step="0.1" value={(riskConfigs[activeMode].maxDrawdown * 100) || 0}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          onRiskConfigsChange({ ...riskConfigs, [activeMode]: { ...riskConfigs[activeMode], maxDrawdown: isNaN(val) ? 0 : val / 100 } });
                        }}
                        className="w-full bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium text-gray-400 mb-1">Conf. Threshold</label>
                      <input type="number" value={riskConfigs[activeMode].confidenceThreshold || 0}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          onRiskConfigsChange({ ...riskConfigs, [activeMode]: { ...riskConfigs[activeMode], confidenceThreshold: isNaN(val) ? 0 : val } });
                        }}
                        className="w-full bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-gray-400 mb-1">Max Positions</label>
                      <input type="number" value={riskConfigs[activeMode].maxConcurrentPositions || 0}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          onRiskConfigsChange({ ...riskConfigs, [activeMode]: { ...riskConfigs[activeMode], maxConcurrentPositions: isNaN(val) ? 0 : val } });
                        }}
                        className="w-full bg-[#1e1e1e] border border-white/10 rounded px-2 py-1 text-xs text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={onGetAiRecommendations}
                    className="flex-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 py-1.5 rounded text-[10px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none">AI Recommend</button>
                  <button onClick={onResetRiskConfigs}
                    className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none">Reset</button>
                </div>
                <button onClick={onSaveRiskConfigs}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2 rounded text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none">Save Configuration</button>
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
  );
}
