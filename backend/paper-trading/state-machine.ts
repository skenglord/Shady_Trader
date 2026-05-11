export type PaperTradingState = 
  | 'IDLE'
  | 'PENDING_ORDER'
  | 'OPEN_POSITION'
  | 'PENDING_CLOSE'
  | 'CLOSED'
  | 'ERROR';

export type PaperTradingEvent = 
  | 'CREATE_ORDER'
  | 'FILL_ORDER'
  | 'CANCEL_ORDER'
  | 'UPDATE_PRICE'
  | 'CLOSE_POSITION'
  | 'ERROR_OCCURRED'
  | 'RESET';

export interface PaperTradingContext {
  positionId?: string;
  symbol?: string;
  side?: 'buy' | 'sell';
  amount?: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  error?: string;
  timestamp: number;
}

interface Transition {
  from: PaperTradingState | PaperTradingState[];
  to: PaperTradingState;
  event: PaperTradingEvent;
  guard?: (ctx: PaperTradingContext) => boolean;
  action?: (ctx: PaperTradingContext) => void;
}

export class PaperTradingStateMachine {
  private currentState: PaperTradingState;
  private context: PaperTradingContext;
  private transitions: Transition[] = [];
  private stateHistory: Array<{ state: PaperTradingState; context: PaperTradingContext; timestamp: number }> = [];

  constructor(initialContext: PaperTradingContext = { timestamp: Date.now() }) {
    this.currentState = 'IDLE';
    this.context = { ...initialContext };
    this.configureTransitions();
    this.recordStateChange('IDLE', this.context);
  }

  private configureTransitions(): void {
    // IDLE state transitions
    this.addTransition({
      from: 'IDLE',
      to: 'PENDING_ORDER',
      event: 'CREATE_ORDER',
      guard: (ctx) => this.validateOrderCreation(ctx),
      action: (ctx) => this.onOrderCreated(ctx),
    });

    // PENDING_ORDER state transitions
    this.addTransition({
      from: 'PENDING_ORDER',
      to: 'OPEN_POSITION',
      event: 'FILL_ORDER',
      guard: (ctx) => this.validateOrderFill(ctx),
      action: (ctx) => this.onOrderFilled(ctx),
    });

    this.addTransition({
      from: 'PENDING_ORDER',
      to: 'IDLE',
      event: 'CANCEL_ORDER',
      action: (ctx) => this.onOrderCancelled(ctx),
    });

    this.addTransition({
      from: 'PENDING_ORDER',
      to: 'ERROR',
      event: 'ERROR_OCCURRED',
      action: (ctx) => this.onError(ctx),
    });

    // OPEN_POSITION state transitions
    this.addTransition({
      from: 'OPEN_POSITION',
      to: 'PENDING_CLOSE',
      event: 'CLOSE_POSITION',
      guard: (ctx) => this.validateClosePosition(ctx),
      action: (ctx) => this.onCloseInitiated(ctx),
    });

    this.addTransition({
      from: 'OPEN_POSITION',
      to: 'OPEN_POSITION',
      event: 'UPDATE_PRICE',
      action: (ctx) => this.onPriceUpdated(ctx),
    });

    this.addTransition({
      from: 'OPEN_POSITION',
      to: 'ERROR',
      event: 'ERROR_OCCURRED',
      action: (ctx) => this.onError(ctx),
    });

    // PENDING_CLOSE state transitions
    this.addTransition({
      from: 'PENDING_CLOSE',
      to: 'CLOSED',
      event: 'FILL_ORDER',
      guard: (ctx) => this.validateCloseFill(ctx),
      action: (ctx) => this.onPositionClosed(ctx),
    });

    this.addTransition({
      from: 'PENDING_CLOSE',
      to: 'OPEN_POSITION',
      event: 'CANCEL_ORDER',
      action: (ctx) => this.onCloseCancelled(ctx),
    });

    // ERROR state transitions
    this.addTransition({
      from: 'ERROR',
      to: 'IDLE',
      event: 'RESET',
      action: (ctx) => this.onReset(ctx),
    });

    // CLOSED state transitions
    this.addTransition({
      from: 'CLOSED',
      to: 'IDLE',
      event: 'RESET',
      action: (ctx) => this.onReset(ctx),
    });
  }

  private addTransition(transition: Transition): void {
    this.transitions.push(transition);
  }

  private validateOrderCreation(ctx: PaperTradingContext): boolean {
    return !!
      ctx.symbol &&
      ctx.side &&
      ctx.amount && ctx.amount > 0 &&
      ctx.price && ctx.price > 0 &&
      ctx.leverage && ctx.leverage > 0;
  }

  private validateOrderFill(ctx: PaperTradingContext): boolean {
    // For canTransition check, we just need to know if the fields exist
    // The actual validation happens when the event is sent with context
    return !!ctx.positionId;
  }

  private validateClosePosition(ctx: PaperTradingContext): boolean {
    return !!ctx.positionId;
  }

  private validateCloseFill(ctx: PaperTradingContext): boolean {
    return !!ctx.positionId;
  }

  private onOrderCreated(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      timestamp: Date.now(),
    });
  }

  private onOrderFilled(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      timestamp: Date.now(),
    });
  }

  private onOrderCancelled(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      timestamp: Date.now(),
    });
  }

  private onCloseInitiated(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      timestamp: Date.now(),
    });
  }

  private onCloseCancelled(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      timestamp: Date.now(),
    });
  }

  private onPositionClosed(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      timestamp: Date.now(),
    });
  }

  private onPriceUpdated(ctx: PaperTradingContext): void {
    if (ctx.currentPrice && ctx.price) {
      const unrealizedPnl = ctx.side === 'buy'
        ? (ctx.currentPrice - ctx.price) * (ctx.amount || 0)
        : (ctx.price - ctx.currentPrice) * (ctx.amount || 0);
      
      this.updateContext({
        ...ctx,
        currentPrice: ctx.currentPrice,
        unrealizedPnl,
        timestamp: Date.now(),
      });
    }
  }

  private onError(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      timestamp: Date.now(),
    });
  }

  private onReset(ctx: PaperTradingContext): void {
    this.updateContext({
      ...ctx,
      symbol: undefined,
      side: undefined,
      amount: undefined,
      price: undefined,
      stopLoss: undefined,
      takeProfit: undefined,
      leverage: undefined,
      currentPrice: undefined,
      unrealizedPnl: undefined,
      realizedPnl: undefined,
      error: undefined,
      timestamp: Date.now(),
    });
  }

  private updateContext(newContext: Partial<PaperTradingContext>): void {
    this.context = { ...this.context, ...newContext };
  }

  public sendEvent(event: PaperTradingEvent, context?: Partial<PaperTradingContext>): boolean {
    if (context) {
      this.context = { ...this.context, ...context };
    }

    const validTransitions = this.transitions.filter(t => {
      const fromMatch = Array.isArray(t.from) 
        ? t.from.includes(this.currentState)
        : t.from === this.currentState;
      return fromMatch && t.event === event;
    });

    for (const transition of validTransitions) {
      if (!transition.guard || transition.guard(this.context)) {
        this.currentState = transition.to;
        if (transition.action) {
          transition.action(this.context);
        }
        this.recordStateChange(this.currentState, this.context);
        return true;
      }
    }

    return false;
  }

  public getState(): PaperTradingState {
    return this.currentState;
  }

  public getContext(): PaperTradingContext {
    return { ...this.context };
  }

  private recordStateChange(state: PaperTradingState, context: PaperTradingContext): void {
    this.stateHistory.push({
      state,
      context: { ...context },
      timestamp: Date.now(),
    });
  }

  public getStateHistory(): Array<{ state: PaperTradingState; context: PaperTradingContext; timestamp: number }> {
    return [...this.stateHistory];
  }

  public canTransition(event: PaperTradingEvent): boolean {
    return this.transitions.some(t => {
      const fromMatch = Array.isArray(t.from) 
        ? t.from.includes(this.currentState)
        : t.from === this.currentState;
      return fromMatch && t.event === event;
    });
  }
}
