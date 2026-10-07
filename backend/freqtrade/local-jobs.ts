import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

type LocalJobType = 'download' | 'backtest' | 'validate';
type QueueItem = { type: LocalJobType; payload: Record<string, unknown> };

const pending: QueueItem[] = [];
let running = false;

export function canRunFreqtradeLocally(): boolean {
  if (process.env.FREQTRADE_LOCAL_JOBS !== 'true') return false;
  const candidates = [
    path.join(process.cwd(), 'backend/freqtrade/venv/bin/freqtrade'),
    path.join(path.dirname(new URL(import.meta.url).pathname), 'venv/bin/freqtrade'),
  ];
  return candidates.some(existsSync);
}

export function enqueueFreqtradeLocalJob(type: LocalJobType, payload: Record<string, unknown>): boolean {
  if (!canRunFreqtradeLocally()) return false;
  pending.push({ type, payload });
  void drain();
  return true;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.length) {
      const item = pending.shift()!;
      try {
        const job = { data: item.payload } as import('bullmq').Job<any>;
        if (item.type === 'download') {
          const worker = await import('./workers/dataWorker.js');
          await worker.processFreqtradeDataJob(job);
        } else if (item.type === 'backtest') {
          const worker = await import('./workers/backtestWorker.js');
          await worker.processFreqtradeBacktestJob(job);
        } else {
          const worker = await import('./workers/validateWorker.js');
          await worker.processFreqtradeValidateJob(job);
        }
      } catch (error) {
        logger.error('Local Freqtrade job failed', {
          type: item.type,
          jobId: item.payload.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    running = false;
    if (pending.length) void drain();
  }
}
