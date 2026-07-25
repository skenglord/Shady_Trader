/**
 * BalanceControls — balance management sidebar card + balance modal.
 *
 * Extracted from App() (originally lines ~2279-2374 for the card,
 * ~3276-3360 for the balance modal).
 * Props: data in (balances, showBacktestUI, botBalanceFlash), callbacks out
 * (killBot, allocateBalance, withdrawBalance, halfBalance, doubleBalance).
 */
import React, { useState } from 'react';
import { TrendingUp, TrendingDown, X } from 'lucide-react';

interface Balances {
  mainBalance: number; botBalance: number; activeTradeBalance: number;
  totalPnl: number; totalPnlPct: number;
}

interface BalanceControlsProps {
  balances: Balances;
  showBacktestUI: boolean;
  botBalanceFlash: boolean;
  onKillBot: () => void;
  onAllocate: (amount: number) => void;
  onWithdraw: (amount: number) => void;
  onHalf: () => void;
  onDouble: () => void;
}

export default function BalanceControls(props: BalanceControlsProps) {
  const { balances, showBacktestUI, botBalanceFlash, onKillBot, onAllocate, onWithdraw, onHalf, onDouble } = props;
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [balanceModalType, setBalanceModalType] = useState<'allocate' | 'withdraw'>('allocate');
  const [balanceAmount, setBalanceAmount] = useState('');

  return (
    <>
      <div className={`bg-[#1e1e1e] rounded-xl border transition-colors duration-300 ${showBacktestUI ? 'border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.05)]' : 'border-white/5'} p-4`}>
        <div className="flex justify-between items-center mb-4">
          <h2 className={`font-medium ${showBacktestUI ? 'text-amber-400' : 'text-gray-300'}`}>
            {showBacktestUI ? 'Simulated Balance' : 'Balance Management'}
          </h2>
          <button onClick={onKillBot}
            className="text-[10px] px-2 py-1 bg-red-500/10 text-red-500 border border-red-500/20 rounded hover:bg-red-500/20 transition-colors font-bold uppercase focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none">
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
              <p className={`text-sm font-mono transition-all duration-300 ${botBalanceFlash ? 'text-yellow-300 scale-110' : showBacktestUI ? 'text-amber-400' : 'text-indigo-400'}`}>
                ${balances.botBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className={`bg-black/20 p-2 rounded-lg border ${showBacktestUI ? 'border-amber-500/10' : 'border-white/5'}`}>
              <p className={`text-[10px] uppercase font-semibold ${showBacktestUI ? 'text-amber-500/60' : 'text-gray-500'}`}>In Trades</p>
              <p className="text-sm font-mono text-amber-400">${balances.activeTradeBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
            <div className={`bg-black/20 p-2 rounded-lg border ${showBacktestUI ? 'border-amber-500/10' : 'border-white/5'}`}>
              <p className={`text-[10px] uppercase font-semibold ${showBacktestUI ? 'text-amber-500/60' : 'text-gray-500'}`}>Available</p>
              <p className="text-sm font-mono text-emerald-400">
                ${(balances.botBalance - balances.activeTradeBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>
          <div className="bg-black/20 p-2 rounded-lg border border-white/5">
            <p className={`text-[10px] uppercase font-semibold ${showBacktestUI ? 'text-amber-500/60' : 'text-gray-500'}`}>Profit/Loss</p>
            <div className="flex items-center gap-1">
              <span className={`text-sm font-mono ${balances.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {balances.totalPnl >= 0 ? (
                  <><TrendingUp className="w-3 h-3 inline mr-0.5 text-emerald-400" />+{balances.totalPnl.toFixed(2)}</>
                ) : (
                  <><TrendingDown className="w-3 h-3 inline mr-0.5 text-red-400" />{balances.totalPnl.toFixed(2)}</>
                )}
              </span>
              <span className={`text-[10px] ${balances.totalPnlPct >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                ({balances.totalPnlPct.toFixed(2)}%)
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setBalanceModalType('allocate'); setBalanceAmount(''); setShowBalanceModal(true); }}
              className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none">+ Allocate</button>
            <button onClick={() => { setBalanceModalType('withdraw'); setBalanceAmount(''); setShowBalanceModal(true); }}
              className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none">- Withdraw</button>
          </div>
          <div className="flex gap-2">
            <button onClick={onHalf}
              className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none">1/2 Balance</button>
            <button onClick={onDouble}
              className="flex-1 bg-white/5 hover:bg-white/10 text-white py-1.5 rounded text-[10px] font-medium border border-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none">x2 Balance</button>
          </div>
        </div>
      </div>

      {/* Balance Modal */}
      {showBalanceModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#1e1e1e] w-full max-w-md rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 border-b border-white/5 flex justify-between items-center">
              <h2 className="text-xl font-bold capitalize">{balanceModalType} Funds</h2>
              <button onClick={() => setShowBalanceModal(false)}
                className="text-gray-400 hover:text-white transition-colors focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none" aria-label="Close balance modal">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-6">
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
                  <input type="number" autoFocus value={balanceAmount}
                    onChange={(e) => setBalanceAmount(e.target.value)} placeholder="0.00"
                    className="w-full bg-[#1e1e1e] border border-white/10 rounded-xl pl-8 pr-4 py-3 text-lg font-mono text-white caret-white focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500 focus-visible:outline-none" />
                </div>
                <div className="flex gap-2">
                  {[0.25, 0.5, 0.75, 1].map(pct => (
                    <button key={pct}
                      onClick={() => {
                        const max = balanceModalType === 'allocate' ? balances.mainBalance : balances.botBalance;
                        setBalanceAmount((max * pct).toFixed(2));
                      }}
                      className="flex-1 py-1 text-[10px] rounded bg-white/5 hover:bg-white/10 text-gray-400 border border-white/5 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none">
                      {pct * 100}%
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="p-6 bg-black/20 border-t border-white/5 flex gap-3">
              <button onClick={() => setShowBalanceModal(false)}
                className="flex-1 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none">Cancel</button>
              <button onClick={() => {
                  const amount = parseFloat(balanceAmount);
                  if (amount > 0) {
                    if (balanceModalType === 'allocate') { onAllocate(amount); }
                    else { onWithdraw(amount); }
                    setShowBalanceModal(false);
                  }
                }}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                  balanceModalType === 'allocate' ? 'bg-emerald-500 hover:bg-emerald-600 text-white focus-visible:ring-emerald-500' : 'bg-indigo-500 hover:bg-indigo-600 text-white focus-visible:ring-indigo-500'}`}>
                Confirm {balanceModalType}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
