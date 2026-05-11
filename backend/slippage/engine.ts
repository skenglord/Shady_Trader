import { Decimal } from 'decimal.js';
import { nj } from 'numjs';
import {
  SlippageEngine as ISlippageEngine,
  OrderRequest,
  MarketState,
  SlippageEstimate,
  TimeHorizon,
  TradingRegime,
  AlmgrenChrissParams
} from './types.js';
import { logger } from '../logging/logger.js';

export class SlippageEngine implements ISlippageEngine {
  private baselineVolatility = 0.02; // 2% daily volatility baseline
  private maxVolatilityMultiplier = 5.0;
  private minimumSlippage = new Decimal('0.0001'); // 0.01% minimum slippage
  private emaAlpha = 0.1; // Smoothing factor for volatility EMA
  private emaState = new Map<string, number>();

  constructor() {
    logger.info('SlippageEngine initialized', { service: 'SlippageEngine' });
  }

  async estimateSlippage(
    order: OrderRequest,
    horizon: TimeHorizon = 'immediate'
  ): Promise<SlippageEstimate> {
    // This will be integrated with real market data later
    // For now, return a placeholder estimate
    const baseSlippage = new Decimal('0.001'); // 0.1% base slippage

    return {
      totalSlippage: baseSlippage,
      confidence: 0.5,
      breakdown: {
        permanentImpact: baseSlippage.mul(0.6),
        temporaryImpact: baseSlippage.mul(0.3),
        spreadCost: baseSlippage.mul(0.1)
      },
      horizon
    };
  }

  private calculatePermanentImpact(
    order: OrderRequest,
    marketState: MarketState,
    regime: TradingRegime
  ): Decimal {
    const params = this.getRegimeParameters(regime);
    const volatility = marketState.volatility;
    const adv = this.estimateADV(order.symbol); // Placeholder
    const size = order.size;

    // Almgren-Chriss permanent impact: γ * σ * √(Q/ADV)
    const impact = params.gamma * volatility * Math.sqrt(Number(size) / adv);

    return new Decimal(impact);
  }

  private calculateTemporaryImpact(
    order: OrderRequest,
    marketState: MarketState,
    regime: TradingRegime
  ): Decimal {
    const params = this.getRegimeParameters(regime);
    const volatility = marketState.volatility;
    const volume = this.estimateCurrentVolume(order.symbol); // Placeholder
    const size = order.size;
    const horizon: TimeHorizon = 'immediate';

    // Temporary impact: λ * σ * (Q/V) * e^(-κt)
    const lambda = params.lambda;
    const kappa = params.kappa;
    const timeToExecution = this.getTimeToExecution(horizon);

    const impact = lambda * volatility * (Number(size) / volume) * Math.exp(-kappa * timeToExecution);

    return new Decimal(Math.max(impact, 0));
  }

  private calculateSpreadCost(order: OrderRequest, marketState: MarketState): Decimal {
    const spread = marketState.spread;
    const direction = order.side === 'buy' ? 1 : -1;

    // Spread cost: 0.5 * spread * direction
    return spread.mul(0.5).mul(direction);
  }

  private calculateVolatilityMultiplier(marketState: MarketState): number {
    const vol = marketState.volatility;
    const symbol = 'default'; // Would use actual symbol

    const emaKey = `volatility_${symbol}`;
    const prevEma = this.emaState.get(emaKey) || vol;
    const currentEma = this.emaAlpha * vol + (1 - this.emaAlpha) * prevEma;

    this.emaState.set(emaKey, currentEma);

    return Math.min(currentEma / this.baselineVolatility, this.maxVolatilityMultiplier);
  }

  private calculateSizeMultiplier(order: OrderRequest, marketState: MarketState): number {
    const relativeSize = Number(order.size) / Number(marketState.depth.bidVolume.plus(marketState.depth.askVolume));

    if (relativeSize < 0.01) return 1.0;
    if (relativeSize < 0.1) return 1 + (relativeSize - 0.01) * 2;
    return Math.pow(relativeSize, 0.7);
  }

  private calculateToxicityAdjustment(marketState: MarketState): number {
    const vpin = marketState.depth.vpin;
    const imbalance = Math.abs(0); // Placeholder for order imbalance

    const toxicityScore = (vpin + imbalance) / 2;
    return 1 + toxicityScore * 0.5; // toxicitySensitivity = 0.5
  }

  private calculateConfidence(marketState: MarketState, regime: TradingRegime): number {
    const agePenalty = Math.min((Date.now() - marketState.timestamp) / 1000 / 100, 1);
    const volatilityPenalty = Math.min(marketState.volatility / 0.1, 1); // maxVolatility = 0.1
    const depthPenalty = Math.min(1 / Number(marketState.depth.bidVolume.plus(marketState.depth.askVolume)), 1);

    return Math.max(0, 1 - agePenalty - volatilityPenalty - depthPenalty);
  }

  private getRegimeParameters(regime: TradingRegime): AlmgrenChrissParams {
    const params: Record<TradingRegime, AlmgrenChrissParams> = {
      high_liquidity: { gamma: 0.1, lambda: 0.2, kappa: 0.8, alpha: 0.4, rho: 0.1 },
      normal: { gamma: 0.3, lambda: 0.3, kappa: 0.5, alpha: 0.6, rho: 0.2 },
      low_liquidity: { gamma: 0.6, lambda: 0.5, kappa: 0.2, alpha: 0.8, rho: 0.3 },
      volatile: { gamma: 0.8, lambda: 0.7, kappa: 0.1, alpha: 1.0, rho: 0.4 },
      uncertain: { gamma: 0.4, lambda: 0.4, kappa: 0.4, alpha: 0.7, rho: 0.25 }
    };

    return params[regime];
  }

  private estimateADV(symbol: string): number {
    // Placeholder - would query historical data
    return 1000000; // $1M daily volume
  }

  private estimateCurrentVolume(symbol: string): number {
    // Placeholder - would query real-time data
    return 10000; // $10k per minute
  }

  private getTimeToExecution(horizon: TimeHorizon): number {
    const horizons = {
      immediate: 0.1, // 100ms
      seconds: 1.0,   // 1 second
      minutes: 60.0   // 1 minute
    };

    return horizons[horizon];
  }
}