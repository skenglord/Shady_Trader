import { Decimal } from 'decimal.js';
import { randomUUID } from 'crypto';

export interface PaperPosition {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: Decimal;
  entryPrice: Decimal;
  currentPrice?: Decimal;
  stopLoss?: Decimal;
  takeProfit?: Decimal;
  leverage: number;
  openedAt: number;
  closedAt?: number;
  status: 'open' | 'closed' | 'liquidated';
  realizedPnl?: Decimal;
  unrealizedPnl?: Decimal;
  candlesHeld: number;
  isRunner?: boolean;
  exitReason?: string;
}

export interface PositionUpdate {
  symbol: string;
  currentPrice: Decimal;
  timestamp: number;
}

export interface PnlCalculation {
  unrealizedPnl: Decimal;
  realizedPnl: Decimal;
  totalPnl: Decimal;
  pnlPercentage: Decimal;
  marginUsed: Decimal;
  currentMargin: Decimal;
  roi: Decimal;
}

export class PaperPositionTracker {
  private positions: Map<string, PaperPosition> = new Map();
  private positionHistory: Map<string, PaperPosition[]> = new Map();
  private readonly MAINTENANCE_MARGIN = new Decimal(0.005); // 0.5%

  constructor() {}

  public openPosition(position: Omit<PaperPosition, 'id' | 'status' | 'candlesHeld' | 'openedAt'>): PaperPosition {
    const id = 'id' in position ? position.id : randomUUID();
    const newPosition: PaperPosition = {
      ...position,
      id,
      status: 'open',
      candlesHeld: 0,
      openedAt: Date.now(),
    };

    this.positions.set(id, newPosition);
    
    // Add to position history
    if (!this.positionHistory.has(position.symbol)) {
      this.positionHistory.set(position.symbol, []);
    }
    this.positionHistory.get(position.symbol)!.push(newPosition);

    return newPosition;
  }

  public closePosition(positionId: string, exitPrice: Decimal, timestamp: number): PaperPosition | null {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      return null;
    }

    const pnl = this.calculatePnl(position, exitPrice);
    const closedPosition: PaperPosition = {
      ...position,
      currentPrice: exitPrice,
      realizedPnl: pnl.totalPnl,
      unrealizedPnl: new Decimal(0),
      status: 'closed',
      closedAt: timestamp,
      exitReason: 'manual_close',
    };

    this.positions.set(positionId, closedPosition);
    return closedPosition;
  }

  public updatePositionPrice(positionId: string, currentPrice: Decimal): PaperPosition | null {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      return null;
    }

    const updatedPosition: PaperPosition = {
      ...position,
      currentPrice,
    };

    this.positions.set(positionId, updatedPosition);
    return updatedPosition;
  }

  public updatePositionPriceBySymbol(symbol: string, currentPrice: Decimal, timestamp: number): Array<{ position: PaperPosition; pnl: PnlCalculation; liquidated: boolean }> {
    const results: Array<{ position: PaperPosition; pnl: PnlCalculation; liquidated: boolean }> = [];

    for (const [positionId, position] of this.positions) {
      if (position.symbol === symbol && position.status === 'open') {
        const updatedPosition = this.updatePositionPrice(positionId, currentPrice);
        if (updatedPosition) {
          const pnl = this.calculatePnl(updatedPosition, currentPrice);
          const liquidated = this.checkLiquidation(updatedPosition, currentPrice);

          if (liquidated) {
            this.liquidatePosition(positionId, currentPrice, timestamp);
          }

          results.push({
            position: updatedPosition,
            pnl,
            liquidated,
          });
        }
      }
    }

    return results;
  }

  public incrementCandlesHeld(positionId: string): PaperPosition | null {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      return null;
    }

    const updatedPosition: PaperPosition = {
      ...position,
      candlesHeld: position.candlesHeld + 1,
    };

    this.positions.set(positionId, updatedPosition);
    return updatedPosition;
  }

  public liquidatePosition(positionId: string, currentPrice: Decimal, timestamp: number): PaperPosition | null {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      return null;
    }

    const pnl = this.calculatePnl(position, currentPrice);
    const liquidatedPosition: PaperPosition = {
      ...position,
      currentPrice,
      realizedPnl: pnl.realizedPnl,
      unrealizedPnl: new Decimal(0),
      status: 'liquidated',
      closedAt: timestamp,
      exitReason: 'liquidation',
    };

    this.positions.set(positionId, liquidatedPosition);
    return liquidatedPosition;
  }

  public checkStopLoss(positionId: string, currentPrice: Decimal): boolean {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open' || !position.stopLoss) {
      return false;
    }

    if (position.side === 'buy' && currentPrice.lte(position.stopLoss)) {
      return true;
    }
    if (position.side === 'sell' && currentPrice.gte(position.stopLoss)) {
      return true;
    }

    return false;
  }

  public checkTakeProfit(positionId: string, currentPrice: Decimal): boolean {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open' || !position.takeProfit) {
      return false;
    }

    if (position.side === 'buy' && currentPrice.gte(position.takeProfit)) {
      return true;
    }
    if (position.side === 'sell' && currentPrice.lte(position.takeProfit)) {
      return true;
    }

    return false;
  }

  public checkLiquidation(position: PaperPosition, currentPrice: Decimal): boolean {
    const pnl = this.calculatePnl(position, currentPrice);
    const lossPercentage = pnl.marginUsed.gt(0) 
      ? pnl.totalPnl.abs().div(pnl.marginUsed)
      : new Decimal(0);

    return lossPercentage.gte(new Decimal(1).div(position.leverage).minus(this.MAINTENANCE_MARGIN));
  }

  public calculatePnl(position: PaperPosition, currentPrice?: Decimal): PnlCalculation {
    const price = currentPrice || position.currentPrice || position.entryPrice;
    const isLong = position.side === 'buy';
    const priceDiff = isLong 
      ? price.minus(position.entryPrice)
      : position.entryPrice.minus(price);

    const notionalValue = position.quantity.mul(position.entryPrice);
    const marginUsed = notionalValue.div(new Decimal(position.leverage));
    const currentNotional = position.quantity.mul(price);
    const currentMargin = currentNotional.div(new Decimal(position.leverage));
    
    let pnl: Decimal;
    if (position.status === 'closed' || position.status === 'liquidated') {
      pnl = position.realizedPnl || new Decimal(0);
    } else {
      pnl = isLong 
        ? currentMargin.minus(marginUsed)
        : marginUsed.minus(currentMargin);
    }

    const pnlPercentage = marginUsed.gt(0) 
      ? pnl.div(marginUsed).mul(100)
      : new Decimal(0);

    const roi = marginUsed.gt(0)
      ? pnl.div(marginUsed).mul(100)
      : new Decimal(0);

    return {
      unrealizedPnl: position.status === 'open' ? pnl : new Decimal(0),
      realizedPnl: position.status === 'open' ? new Decimal(0) : pnl,
      totalPnl: pnl,
      pnlPercentage,
      marginUsed,
      currentMargin,
      roi,
    };
  }

  public getPosition(positionId: string): PaperPosition | undefined {
    return this.positions.get(positionId);
  }

  public getOpenPositions(): PaperPosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'open');
  }

  public getPositionsBySymbol(symbol: string): PaperPosition[] {
    return Array.from(this.positions.values()).filter(p => p.symbol === symbol);
  }

  public getPositionHistory(symbol?: string): PaperPosition[] {
    if (symbol) {
      return this.positionHistory.get(symbol) || [];
    }
    return Array.from(this.positionHistory.values()).flat();
  }

  public getTotalUnrealizedPnl(): Decimal {
    return this.getOpenPositions().reduce((sum, position) => {
      const pnl = this.calculatePnl(position, position.currentPrice || position.entryPrice);
      return sum.add(pnl.unrealizedPnl);
    }, new Decimal(0));
  }

  public getTotalRealizedPnl(): Decimal {
    return Array.from(this.positions.values())
      .filter(p => p.status === 'closed' || p.status === 'liquidated')
      .reduce((sum, position) => sum.add(position.realizedPnl || new Decimal(0)), new Decimal(0));
  }

  public getTotalMarginUsed(): Decimal {
    return this.getOpenPositions().reduce((sum, position) => {
      const pnl = this.calculatePnl(position, position.currentPrice || position.entryPrice);
      return sum.add(pnl.marginUsed);
    }, new Decimal(0));
  }

  public getPositionCount(): { total: number; open: number; closed: number; liquidated: number } {
    const positions = Array.from(this.positions.values());
    return {
      total: positions.length,
      open: positions.filter(p => p.status === 'open').length,
      closed: positions.filter(p => p.status === 'closed').length,
      liquidated: positions.filter(p => p.status === 'liquidated').length,
    };
  }
}
