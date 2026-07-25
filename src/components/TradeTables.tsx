/**
 * TradeTables — open positions, closed bot trades, and shadow/backtest trades tables.
 *
 * Extracted from App() (originally lines ~2627-2949).
 * Props: data in (openPositions, botTrades, closedTrades, backtestTrades, etc.),
 * callbacks out (closePosition, updatePositionParams).
 */
import React, { useState } from 'react';
import { Activity, X, Settings } from 'lucide-react';

interface TradeTablesProps {
  showBacktestUI: boolean;
  openPositions: any[];
  botTrades: any[];
  closedTrades: any[];
  backtestTrades: any[];
  currentPrice: number;
  tradeFilter: string;
  onTradeFilterChange: (filter: string) => void;
  modeVisibility: Record<string, boolean>;
  onClosePosition: (tradeId: string) => void;
  onUpdatePositionParams: (tradeId: string, stopLoss: number, takeProfit: number) => void;
}

export default function TradeTables(props: TradeTablesProps) {
  const {
    showBacktestUI, openPositions, botTrades, closedTrades, backtestTrades,
    currentPrice, tradeFilter, onTradeFilterChange, modeVisibility,
    onClosePosition, onUpdatePositionParams,
  } = props;

  const [editingPosition, setEditingPosition] = useState<string | null>(null);
  const [editSl, setEditSl] = useState<number>(0);
  const [editTp, setEditTp] = useState<number>(0);

  return (
    <div className="space-y-6">
      {/* Open Positions */}
      {!showBacktestUI && (
        <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-medium text-indigo-400 flex items-center gap-2">
              <Activity className="w-4 h-4" />Open Positions
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
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${pos.side === 'buy' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>{pos.side}</span>
                      <span className="text-xs font-mono text-white">{pos.symbol}</span>
                      <span className="text-[10px] bg-white/5 px-1.5 py-0.5 rounded text-gray-400 border border-white/5">{pos.leverage}x</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const posId = pos.id || `pos_${i}`;
                          if (isEditing) { setEditingPosition(null); }
                          else { setEditingPosition(posId); setEditSl(pos.stopLoss || 0); setEditTp(pos.takeProfit || 0); }
                        }}
                        className="p-1 hover:bg-white/5 rounded transition-colors text-gray-500 hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none"
                        aria-label="Edit TP/SL" title="Edit TP/SL">
                        <Settings className="w-3 h-3" />
                      </button>
                      <button onClick={() => onClosePosition(pos.id)}
                        className="p-1 hover:bg-red-500/20 rounded transition-colors text-gray-500 hover:text-red-400 focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none"
                        aria-label="Close position" title="Close Position">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {isEditing ? (
                    <div className="mt-2 p-2 bg-black/40 rounded border border-indigo-500/30 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[8px] text-gray-500 uppercase block mb-1">Stop Loss</label>
                          <input type="number" value={editSl} onChange={(e) => setEditSl(Number(e.target.value))}
                            className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:border-indigo-500 outline-none" />
                        </div>
                        <div>
                          <label className="text-[8px] text-gray-500 uppercase block mb-1">Take Profit</label>
                          <input type="number" value={editTp} onChange={(e) => setEditTp(Number(e.target.value))}
                            className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:border-indigo-500 outline-none" />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { onUpdatePositionParams(pos.id, editSl, editTp); setEditingPosition(null); }}
                          className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] py-1 rounded transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none">Save</button>
                        <button onClick={() => setEditingPosition(null)}
                          className="flex-1 bg-white/5 hover:bg-white/10 text-gray-400 text-[10px] py-1 rounded transition-colors focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none">Cancel</button>
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
                        <p className={`font-mono text-sm ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</p>
                        <p className={`font-mono text-[10px] ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</p>
                        <p className="text-[8px] text-gray-600 mt-1">{pos.risk_mode.replace('_', ' ')}</p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {openPositions.length === 0 && (
              <div className="text-center py-4"><p className="text-xs text-gray-600 italic">No open positions</p></div>
            )}
          </div>
        </div>
      )}

      {/* Closed Bot Trades */}
      {!showBacktestUI && (
        <div className="bg-[#1e1e1e] rounded-xl border border-white/5 p-4 flex-1">
          <h2 className="font-medium mb-3 text-indigo-300">Closed Bot Trades</h2>
          <div className="overflow-x-auto max-h-[200px] overflow-y-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-[10px] uppercase text-gray-400 bg-white/5 sticky top-0">
                <tr>
                  <th className="px-2 py-2 rounded-tl-lg">Time</th>
                  <th className="px-2 py-2">Closed</th>
                  <th className="px-2 py-2">Side</th>
                  <th className="px-2 py-2">Entry/Exit</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">PnL $</th>
                  <th className="px-2 py-2 rounded-tr-lg">Status</th>
                </tr>
              </thead>
              <tbody>
                {botTrades.slice(0, 100).map((trade: any, i: number) => {
                  const pnl = trade.pnl || 0;
                  const timestamp = trade.timestamp || 0;
                  const exitTs = trade.exit_timestamp || 0;
                  const entryPrice = trade.entryPrice || trade.price;
                  const exitPrice = trade.exitPrice || trade.exit_price;
                  return (
                    <tr key={trade.id || i} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-2 py-2 text-gray-400 font-mono text-[9px]">{timestamp ? new Date(timestamp).toLocaleString() : '---'}</td>
                      <td className="px-2 py-2 text-gray-500 font-mono text-[9px]">{exitTs ? new Date(exitTs).toLocaleString() : '—'}</td>
                      <td className="px-2 py-2"><span className={`font-bold text-[10px] ${trade.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>{(trade.side || '').toUpperCase()}</span></td>
                      <td className="px-2 py-2 font-mono text-[10px] whitespace-nowrap">
                        <span className="text-white">${entryPrice?.toFixed(0) || '---'}</span>
                        <span className="text-gray-600"> → </span>
                        <span className={exitPrice ? (exitPrice > entryPrice ? 'text-emerald-400' : 'text-red-400') : 'text-gray-500'}>{exitPrice ? `$${exitPrice.toFixed(0)}` : '—'}</span>
                      </td>
                      <td className="px-2 py-2 font-mono text-[10px] text-gray-300">{(trade.amount || 0).toFixed(4)}</td>
                      <td className={`px-2 py-2 font-mono text-[10px] ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</td>
                      <td className="px-2 py-2"><span className={`text-[8px] px-1 py-0.5 rounded ${pnl >= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>CLOSED</span></td>
                    </tr>
                  );
                })}
                {botTrades.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-gray-500 py-4 text-sm">No bot trades yet — only shadow trading active</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Shadow Trades / Backtest Trades */}
      <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.05)]' : 'border-white/5'} p-4 flex-1`}>
        <h2 className={`font-medium mb-2 ${showBacktestUI ? 'text-amber-400' : ''}`}>
          {showBacktestUI ? 'Backtest Trades' : 'All Closed Shadow Trades'}
        </h2>
        {!showBacktestUI && (
          <div className="mb-3">
            <input type="text" placeholder="Filter by mode, side..." value={tradeFilter}
              onChange={(e) => onTradeFilterChange(e.target.value)}
              aria-label="Filter closed trades by mode or side"
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/50" />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className={`text-[10px] uppercase ${showBacktestUI ? 'text-amber-500/60 bg-amber-500/5' : 'text-gray-400 bg-white/5'}`}>
              <tr>
                <th className="px-2 py-2 rounded-tl-lg">Time</th>
                <th className="px-2 py-2">Closed</th>
                <th className="px-2 py-2">Mode</th>
                <th className="px-2 py-2">Side</th>
                <th className="px-2 py-2">Entry/Exit</th>
                <th className="px-2 py-2">Amount</th>
                <th className="px-2 py-2">Wager</th>
                <th className="px-2 py-2">PnL $</th>
                <th className="px-2 py-2">PnL %</th>
                <th className="px-2 py-2 rounded-tr-lg">Status</th>
              </tr>
            </thead>
            <tbody>
              {(showBacktestUI ? backtestTrades : closedTrades)
                .filter((trade: any) => {
                  const mode = (trade.risk_mode || trade.mode || '').toLowerCase();
                  const side = (trade.side || '').toLowerCase();
                  const filter = tradeFilter.toLowerCase();
                  return !filter || mode.includes(filter) || side.includes(filter);
                })
                .sort((a: any, b: any) => {
                  const aTime = a.timestamp || a.time || a.exitTime || 0;
                  const bTime = b.timestamp || b.time || b.exitTime || 0;
                  return bTime - aTime;
                }).slice(0, 200).map((trade: any, i: number) => {
                  const modeColors: Record<string, string> = {
                    ultra_conservative: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/20',
                    conservative: 'bg-blue-500/20 text-blue-300 border-blue-500/20',
                    moderate: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/20',
                    aggressive: 'bg-amber-500/20 text-amber-300 border-amber-500/20',
                    degen: 'bg-red-500/20 text-red-300 border-red-500/20',
                    ai_enhanced: 'bg-purple-500/20 text-purple-300 border-purple-500/20',
                  };
                  const mode = trade.risk_mode || trade.mode || 'moderate';
                  const modeColor = modeColors[mode] || 'bg-gray-500/20 text-gray-300 border-gray-500/20';
                  const isOpen = !(trade.status === 'closed' || trade.exitTime || trade.exitTimestamp);
                  const pnl = trade.pnl || trade.profitLoss || 0;
                  const timestamp = trade.timestamp || trade.time || trade.exitTime;
                  const exitTimestamp = trade.exit_timestamp || trade.exitTime || 0;
                  const entryPrice = trade.entryPrice || trade.price;
                  const exitPrice = trade.exitPrice || trade.exit_price;
                  const leverage = trade.leverage || 1;
                  const amount = trade.amount || 0;
                  const wager = amount * entryPrice / leverage;
                  const pnlPct = wager > 0 ? (pnl / wager) * 100 : 0;
                  if (!showBacktestUI && !modeVisibility[mode]) return null;
                  return (
                    <tr key={trade.id || i} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                      <td className="px-2 py-2 text-gray-400 font-mono whitespace-nowrap text-[9px]">{timestamp ? new Date(timestamp).toLocaleString() : '---'}</td>
                      <td className="px-2 py-2 text-gray-500 font-mono whitespace-nowrap text-[9px]">{exitTimestamp && !isOpen ? new Date(exitTimestamp).toLocaleString() : '—'}</td>
                      <td className="px-2 py-2"><span className={`text-[8px] px-1 py-0.5 rounded border ${modeColor}`}>{mode.replace('_', ' ')}</span></td>
                      <td className="px-2 py-2"><span className={`font-bold text-[10px] ${(trade.side === 'buy' || trade.side === 'long') ? 'text-emerald-400' : 'text-red-400'}`}>{(trade.side === 'buy' || trade.side === 'long') ? 'BUY' : 'SELL'}</span></td>
                      <td className="px-2 py-2 font-mono text-[10px] whitespace-nowrap">
                        <span className="text-white">${entryPrice?.toFixed(0) || '---'}</span>
                        <span className="text-gray-600"> → </span>
                        <span className={exitPrice ? (exitPrice > entryPrice ? 'text-emerald-400' : 'text-red-400') : 'text-gray-500'}>{exitPrice ? `$${exitPrice.toFixed(0)}` : '—'}</span>
                      </td>
                      <td className="px-2 py-2 font-mono text-[10px] text-gray-300">{amount > 0 ? amount.toFixed(4) : '—'}</td>
                      <td className="px-2 py-2 font-mono text-[10px] text-gray-400">{wager > 0 ? `$${wager.toFixed(0)}` : '—'}</td>
                      <td className={`px-2 py-2 font-mono text-[10px] ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</td>
                      <td className={`px-2 py-2 font-mono text-[10px] ${pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</td>
                      <td className="px-2 py-2">
                        {isOpen ? (
                          <span className="text-[8px] px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/20">OPEN</span>
                        ) : (
                          <span className={`text-[8px] px-1 py-0.5 rounded ${pnl >= 0 ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/20' : 'bg-red-500/20 text-red-300 border border-red-500/20'}`}>CLOSED</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              {((showBacktestUI ? backtestTrades : closedTrades.filter((t: any) => {
                const mode = (t.risk_mode || t.mode || '').toLowerCase();
                const side = (t.side || '').toLowerCase();
                const filter = tradeFilter.toLowerCase();
                return !filter || mode.includes(filter) || side.includes(filter);
              })).length === 0) && (
                <tr><td colSpan={10} className="text-center text-gray-500 py-4 text-sm">No trades yet — trades appear as the engine runs</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
