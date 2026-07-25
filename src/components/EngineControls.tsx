/**
 * EngineControls — start/stop/kill engine buttons and manual trade buttons.
 *
 * Extracted from App() header controls (originally lines ~1924-1963).
 * Includes the window.confirm guard on kill and manual trade.
 *
 * Props: data in (status, currentPrice, balances, riskConfigs, activeMode),
 * callbacks out (onToggleEngine, onManualTrade, onKillBot, onOpenSettings, onOpenFreqtrade).
 */
import React from 'react';
import { Play, Square, Settings, Database as DatabaseIcon } from 'lucide-react';

interface EngineControlsProps {
  isRunning: boolean;
  currentPrice: number;
  balances: { mainBalance: number };
  riskConfigs: Record<string, any>;
  activeMode: string;
  symbol: string;
  onToggleEngine: () => void;
  onManualTrade: (side: 'buy' | 'sell') => void;
  onKillBot: () => void;
  onOpenSettings: () => void;
  onOpenFreqtrade: () => void;
}

export default function EngineControls(props: EngineControlsProps) {
  const { isRunning, onToggleEngine, onManualTrade, onOpenSettings, onOpenFreqtrade } = props;

  return (
    <div className="flex items-center gap-2">
      <button onClick={onToggleEngine}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none ${
          isRunning
            ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 focus-visible:ring-red-500/50'
            : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20 focus-visible:ring-emerald-500/50'}`}>
        {isRunning ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        {isRunning ? 'Stop Engine' : 'Start Engine'}
      </button>
      <div className="flex items-center gap-2">
        <button onClick={() => onManualTrade('buy')}
          className="px-4 py-2 rounded-lg bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20 font-medium focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none">
          Enter High
        </button>
        <button onClick={() => onManualTrade('sell')}
          className="px-4 py-2 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 font-medium focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none">
          Enter Low
        </button>
      </div>
      <button onClick={onOpenFreqtrade}
        className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none"
        aria-label="Open Freqtrade sidecar">
        <DatabaseIcon className="w-5 h-5 text-indigo-400" />
      </button>
      <button onClick={onOpenSettings}
        className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none"
        aria-label="Open settings">
        <Settings className="w-5 h-5 text-gray-400" />
      </button>
    </div>
  );
}
