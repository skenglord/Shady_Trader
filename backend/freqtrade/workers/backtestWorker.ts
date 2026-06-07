/**
 * Freqtrade backtest worker (Phase 3 step 3.3)
 *
 * Calls FreqtradeBridge.runBacktest() and persists the parsed BacktestResult
 * to the freqtrade_jobs table. Always passes --cache none (B5 mitigation).
 */
import { Job } from 'bullmq';
import { runQuery } from '../../database.js';
import { logger } from '../../logging/logger.js';
import { recordFreqtradeJob } from '../../observability/freqtrade_metrics.js';

export const BACKTEST_QUEUE_NAME = 'freqtrade-backtest';

export interface FreqtradeBacktestJobData {
    jobId: string;
    strategy: string;
    timerange?: { start?: string; end?: string };
    pairs: string[];
    timeframe: string;
    dryRunWallet: number;
    fee?: number;
}

export async function processFreqtradeBacktestJob(job: Job<FreqtradeBacktestJobData>): Promise<{ ok: boolean; warnings: string[] }> {
    const { jobId, ...req } = job.data;
    logger.info('[freqtrade-backtest] starting', { jobId, strategy: req.strategy });
    const startTime = Date.now();

    await runQuery(`UPDATE freqtrade_jobs SET status='running', started_at=?, updated_at=? WHERE id=?`,
        [Date.now(), Date.now(), jobId], 'run');

    try {
        const { FreqtradeBridge } = await import('../bridge.js');
        const bridge = new FreqtradeBridge();
        const result = await bridge.runBacktest(req);

        // BacktestResult.metadata.success is the typed boolean field (not result.ok)
        const ok: boolean = result.metadata.success && result.metadata.exitCode === 0;
        const durationSec = (Date.now() - startTime) / 1000;

        await runQuery(`UPDATE freqtrade_jobs SET status=?, result_json=?, completed_at=?, updated_at=? WHERE id=?`,
            [ok ? 'completed' : 'failed', JSON.stringify(result), Date.now(), Date.now(), jobId], 'run');

        recordFreqtradeJob('backtest', ok ? 'completed' : 'failed', durationSec);

        logger.info('[freqtrade-backtest] finished', { jobId, ok, exitCode: result.metadata.exitCode });
        return { ok, warnings: result.warnings ?? [] };
    } catch (err: any) {
        const durationSec = (Date.now() - startTime) / 1000;
        await runQuery(`UPDATE freqtrade_jobs SET status='failed', error=?, completed_at=?, updated_at=? WHERE id=?`,
            [String(err?.message ?? err), Date.now(), Date.now(), jobId], 'run');
        logger.error('[freqtrade-backtest] failed', { jobId, error: err?.message });
        recordFreqtradeJob('backtest', 'failed', durationSec);
        throw err;
    }
}
