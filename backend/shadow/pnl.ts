export interface PnlTrade {
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  totalFeeFrac?: number;
}

/** Calculate spot/contract-unit P&L after entry/exit fees and adverse exit slip. */
export function calculateTradePnl(trade: PnlTrade, midExitPrice: number): number {
  const amount = Number(trade.amount);
  const entryPrice = Number(trade.price);
  const feeRate = Number(process.env.TAKER_FEE_RATE ?? '0.0006');
  const exitSlippage = Number(process.env.FIXED_SLIPPAGE_FALLBACK ?? '0.0005');
  const entryFee = Number(trade.totalFeeFrac ?? feeRate);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(entryPrice) || entryPrice <= 0 ||
      !Number.isFinite(midExitPrice) || midExitPrice <= 0 || !Number.isFinite(feeRate) || feeRate < 0 ||
      !Number.isFinite(entryFee) || entryFee < 0 || !Number.isFinite(exitSlippage) || exitSlippage < 0 || exitSlippage >= 1) {
    throw new Error('Invalid trade values or fee/slippage configuration for P&L');
  }
  const effectiveExit = trade.side === 'buy'
    ? midExitPrice * (1 - exitSlippage)
    : midExitPrice * (1 + exitSlippage);
  const gross = trade.side === 'buy'
    ? amount * (effectiveExit - entryPrice)
    : amount * (entryPrice - effectiveExit);
  const entryFees = amount * entryPrice * entryFee;
  const exitFees = amount * effectiveExit * feeRate;
  return gross - entryFees - exitFees;
}
