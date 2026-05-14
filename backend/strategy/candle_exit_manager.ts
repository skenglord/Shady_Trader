import { logger } from '../logging/logger.js';

export interface ExitConfig {
  checkpoints: number[];
  closeOnGreenAt: number;
  forceCloseAt: number;
  timeframeMs: number;
}

export type ExitReason =
  | 'green_at_checkpoint'
  | 'stop_loss'
  | 'force_close'
  | 'cancelled';

export interface ExitEvent {
  tradeId: string;
  reason: ExitReason;
  checkpoint: number;
  elapsed_ms: number;
}

type ExitCallback = (event: ExitEvent) => Promise<void>;

export function parseExitConfig(timeframeMs: number): ExitConfig {
  const raw = (process.env.ML_EXIT_CHECKPOINTS ?? '0.05,0.12,0.20,0.35,0.50,0.80')
    .split(',').map(Number).filter(n => n > 0 && n < 1);

  return {
    checkpoints: raw,
    closeOnGreenAt: Number(process.env.ML_EXIT_CLOSE_ON_GREEN_AT ?? '0.20'),
    forceCloseAt: Number(process.env.ML_EXIT_FORCE_CLOSE_AT ?? '0.92'),
    timeframeMs
  };
}

export class CandleExitManager {
  private activeTimers = new Map<string, NodeJS.Timeout[]>();

  scheduleExits(
    tradeId: string,
    entryPrice: number,
    candleOpenMs: number,
    config: ExitConfig,
    getPriceNow: () => number,
    onExit: ExitCallback
  ): void {
    if (this.activeTimers.has(tradeId)) {
      logger.warn(`[exit_mgr] Trade ${tradeId} already has scheduled exits`);
      return;
    }

    const timers: NodeJS.Timeout[] = [];
    const now = Date.now();

    for (const checkpoint of config.checkpoints) {
      const triggerAt = candleOpenMs + config.timeframeMs * checkpoint;
      const delay = triggerAt - now;

      if (delay <= 0) continue;

      const t = setTimeout(async () => {
        if (!this.activeTimers.has(tradeId)) return;

        const currentPrice = getPriceNow();
        const returnPct = (currentPrice - entryPrice) / entryPrice;
        const isGreen = returnPct > 0;

        if (checkpoint >= config.closeOnGreenAt && isGreen) {
          this.cancelAll(tradeId);
          await onExit({
            tradeId,
            reason: 'green_at_checkpoint',
            checkpoint,
            elapsed_ms: Date.now() - candleOpenMs
          });
        }
      }, delay);

      timers.push(t);
    }

    const forceAt = candleOpenMs + config.timeframeMs * config.forceCloseAt;
    const forceDelay = forceAt - now;

    if (forceDelay > 0) {
      const forceTimer = setTimeout(async () => {
        if (!this.activeTimers.has(tradeId)) return;
        this.cancelAll(tradeId);
        await onExit({
          tradeId,
          reason: 'force_close',
          checkpoint: config.forceCloseAt,
          elapsed_ms: Date.now() - candleOpenMs
        });
      }, forceDelay);
      timers.push(forceTimer);
    }

    this.activeTimers.set(tradeId, timers);
    logger.debug(
      `[exit_mgr] Scheduled ${timers.length} exit checks for trade ${tradeId} ` +
      `(closeOnGreen@${(config.closeOnGreenAt * 100).toFixed(0)}%, ` +
      `forceClose@${(config.forceCloseAt * 100).toFixed(0)}%)`
    );
  }

  cancelAll(tradeId: string): void {
    const timers = this.activeTimers.get(tradeId);
    if (timers) {
      timers.forEach(clearTimeout);
      this.activeTimers.delete(tradeId);
    }
  }

  cancelAllActive(): void {
    for (const tradeId of this.activeTimers.keys()) {
      this.cancelAll(tradeId);
    }
  }

  get activeTradeCount(): number {
    return this.activeTimers.size;
  }
}