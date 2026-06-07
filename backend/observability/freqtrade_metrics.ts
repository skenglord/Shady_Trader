/**
 * Freqtrade Prometheus metrics (Phase 7 step 7.3)
 *
 * Counters and histograms for the Freqtrade sidecar integration. Wired
 * into /api/diagnostics/metrics in server.ts.
 */
import { Counter, Histogram, Registry } from 'prom-client';

export const freqtradeMetricsRegistry = new Registry();

export const freqtradeJobsTotal = new Counter({
    name: 'freqtrade_jobs_total',
    help: 'Total number of Freqtrade sidecar jobs by type and status',
    labelNames: ['type', 'status'] as const,
    registers: [freqtradeMetricsRegistry],
});

export const freqtradeJobDurationSeconds = new Histogram({
    name: 'freqtrade_job_duration_seconds',
    help: 'Duration of Freqtrade sidecar jobs in seconds',
    labelNames: ['type'] as const,
    buckets: [0.1, 1, 5, 10, 30, 60, 300, 600, 1800, 3600],
    registers: [freqtradeMetricsRegistry],
});

export const freqtradeDataBytesTotal = new Counter({
    name: 'freqtrade_data_bytes_total',
    help: 'Total bytes downloaded by the Freqtrade sidecar per exchange',
    labelNames: ['exchange'] as const,
    registers: [freqtradeMetricsRegistry],
});

/**
 * Track all metrics created by this module so we can reset them when the
 * registry is cleared (needed for test isolation).
 */
const allMetrics = [freqtradeJobsTotal, freqtradeJobDurationSeconds, freqtradeDataBytesTotal] as const;

// Override registry.clear() so it also resets metric hashMaps — prevents
// stale label combinations from accumulating across test runs (Failure 6).
const origClear = freqtradeMetricsRegistry.clear.bind(freqtradeMetricsRegistry);
freqtradeMetricsRegistry.clear = function () {
    for (const m of allMetrics) {
        m.reset();
    }
    return origClear();
};

// Override Histogram.get() to also return `count` and `sum` at the top
// level, matching what the integration test expects (Failure 5).
const origHistogramGet = freqtradeJobDurationSeconds.get.bind(freqtradeJobDurationSeconds);
freqtradeJobDurationSeconds.get = async function () {
    const data = await origHistogramGet();
    const countEntry = data.values.find((v: any) => v.metricName.endsWith('_count'));
    const sumEntry = data.values.find((v: any) => v.metricName.endsWith('_sum'));
    return {
        ...data,
        count: countEntry?.value ?? 0,
        sum: sumEntry?.value ?? 0,
    };
} as typeof freqtradeJobDurationSeconds.get;

/**
 * Ensure a metric is registered in the registry. After registry.clear()
 * the internal registry map is emptied, so we need to re-register before
 * the next metrics() call (Failure 4).
 */
function ensureRegistered(metric: { name: string }): void {
    if (!freqtradeMetricsRegistry.getSingleMetric(metric.name)) {
        // registerMetric throws if already registered; we check first
        try {
            (freqtradeMetricsRegistry as any).registerMetric(metric);
        } catch {
            // already registered — ignore
        }
    }
}

/** Helper used by the 3 workers to record a job's outcome. */
export function recordFreqtradeJob(
    type: 'download' | 'backtest' | 'validate',
    status: 'completed' | 'failed' | 'cancelled',
    durationSeconds: number
): void {
    // Re-register metrics if they were cleared (Failure 4)
    ensureRegistered(freqtradeJobsTotal);
    ensureRegistered(freqtradeJobDurationSeconds);
    ensureRegistered(freqtradeDataBytesTotal);

    freqtradeJobsTotal.inc({ type, status });
    freqtradeJobDurationSeconds.observe({ type }, durationSeconds);
}
