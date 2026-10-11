import type { NormalizedExchangeFill } from './account-execution-adapter.js';

export type FillFeeValuation = { baseAmount: number; quoteAmount: number; quoteValue: number };

/** Value base- and quote-denominated fees using the authoritative fill price. */
export function valueFillFee(fill: Pick<NormalizedExchangeFill, 'symbol' | 'fee' | 'feeCurrency' | 'price'>): FillFeeValuation | null {
  if (!Number.isFinite(fill.fee) || !Number.isFinite(fill.price) || fill.price <= 0) return null;
  if (fill.fee === 0) return { baseAmount: 0, quoteAmount: 0, quoteValue: 0 };
  const [base, quote, ...extra] = fill.symbol.split('/');
  if (!base || !quote || extra.length || !fill.feeCurrency) return null;
  const currency = fill.feeCurrency.trim().toUpperCase();
  if (currency === quote.trim().toUpperCase()) return { baseAmount: 0, quoteAmount: fill.fee, quoteValue: fill.fee };
  if (currency === base.trim().toUpperCase()) return { baseAmount: fill.fee, quoteAmount: 0, quoteValue: fill.fee * fill.price };
  return null;
}
