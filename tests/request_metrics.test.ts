import { describe, test } from 'node:test';
import assert from 'node:assert';
import { getApiMetricsSnapshot, recordApiRequest, resetApiMetrics, toPrometheusMetrics } from '../backend/observability/requestMetrics.js';

describe('request metrics', () => {
  test('tracks aggregate and per-route request latency/error metrics', () => {
    resetApiMetrics();
    recordApiRequest('GET /api/status', 200, 12);
    recordApiRequest('GET /api/status', 200, 18);
    recordApiRequest('POST /api/start', 503, 25);

    const snapshot = getApiMetricsSnapshot();
    assert.strictEqual(snapshot.requests, 3);
    assert.strictEqual(snapshot.errors, 1);
    assert.ok(snapshot.avgLatencyMs > 0);
    assert.ok(snapshot.errorRate > 0);
    assert.ok(Array.isArray(snapshot.slowestRoutes));
    assert.ok(snapshot.slowestRoutes.some((route) => route.route === 'POST /api/start'));
  });

  test('renders prometheus metrics payload', () => {
    resetApiMetrics();
    recordApiRequest('GET /api/status', 200, 10);
    const text = toPrometheusMetrics({
      marketDataFetchCount: 4,
      marketDataFetchFailures: 1,
      newsFetchCount: 2,
      newsFetchFailures: 0
    });

    assert.ok(text.includes('api_requests_total 1'));
    assert.ok(text.includes('market_data_fetch_total 4'));
    assert.ok(text.includes('news_fetch_failures_total 0'));
  });
});
