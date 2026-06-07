/**
 * Freqtrade data download worker (Phase 3 step 3.3)
 *
 * Calls FreqtradeBridge.downloadData() and persists the result/error to
 * the freqtrade_jobs table. Concurrency is fixed at 1 (B9 mitigation) so
 * that download-data and backtesting never race on user_data/.
 */
import { Job } from 'bullmq';
import { runQuery } from '../../database.js';
import { logger } from '../../logging/logger.js';
import { recordFreqtradeJob } from '../../observability/freqtrade_metrics.js';

export const DATA_QUEUE_NAME = 'freqtrade-data';

export interface FreqtradeDataJobData {
    jobId: string;
    exchange: string;
    pairs: string[];
    timeframes: string[];
    timerange?: { start?: string; end?: string };
    tradingMode: 'spot' | 'futures' | 'margin';
    dataFormat: 'json' | 'feather' | 'parquet';
}

export async function processFreqtradeDataJob(job: Job<FreqtradeDataJobData>): Promise<{ ok: boolean; warnings: string[] }> {
    const { jobId, ...req } = job.data;
    logger.info('[freqtrade-data] starting', { jobId, exchange: req.exchange, pairs: req.pairs.length });
    const startTime = Date.now();

    await runQuery(`UPDATE freqtrade_jobs SET status='running', started_at=?, updated_at=? WHERE id=?`,
        [Date.now(), Date.now(), jobId], 'run');

    try {
        // Lazy import so the bridge module is only required when actually used
        const { FreqtradeBridge } = await import('../bridge.js');
        const bridge = new FreqtradeBridge();

        // downloadData returns AsyncIterable<DownloadProgress> — drain it and
        // collect warnings; the final yielded event carries the exit status.
        const progressIterable = await bridge.downloadData(req);
        const warnings: string[] = [];
        let lastEventType: string = 'info';

        for await (const event of progressIterable) {
            lastEventType = event.type;
            if (event.type === 'warning' || event.type === 'error') {
                warnings.push(event.line);
            }
            // Update job progress in DB periodically (every warning/error or final event)
            if (event.type !== 'progress') {
                await runQuery(
                    `UPDATE freqtrade_jobs SET updated_at=? WHERE id=?`,
                    [Date.now(), jobId], 'run'
                ).catch(() => { /* non-critical */ });
            }
        }

        const ok = lastEventType !== 'error' && warnings.filter(w => /^ERROR|Traceback/i.test(w.trim())).length === 0;
        const durationSec = (Date.now() - startTime) / 1000;

        const status = ok ? 'completed' : 'failed';
        await runQuery(`UPDATE freqtrade_jobs SET status='${status}', result_json=?, completed_at=?, updated_at=? WHERE id=?`,
            [JSON.stringify({ ok, warnings }), Date.now(), Date.now(), jobId], 'run');

        recordFreqtradeJob('download', ok ? 'completed' : 'failed', durationSec);

        logger.info('[freqtrade-data] finished', { jobId, ok, warnings: warnings.length });
        return { ok, warnings };
    } catch (err: any) {
        const durationSec = (Date.now() - startTime) / 1000;
        await runQuery(`UPDATE freqtrade_jobs SET status='failed', error=?, completed_at=?, updated_at=? WHERE id=?`,
            [String(err?.message ?? err), Date.now(), Date.now(), jobId], 'run');
        logger.error('[freqtrade-data] failed', { jobId, error: err?.message });
        recordFreqtradeJob('download', 'failed', durationSec);
        throw err;
    }
}
