type RouteMetrics = {
  requests: number;
  errors: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
};

const routes = new Map<string, RouteMetrics>();
let totalRequests = 0;
let totalErrors = 0;
let totalLatencyMs = 0;
let maxLatencyMs = 0;

function getOrCreateRouteMetrics(routeKey: string): RouteMetrics {
  const existing = routes.get(routeKey);
  if (existing) return existing;
  const created: RouteMetrics = {
    requests: 0,
    errors: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0
  };
  routes.set(routeKey, created);
  return created;
}

export function recordApiRequest(routeKey: string, method: string, statusCode: number, latencyMs: number) {
  totalRequests += 1;
  totalLatencyMs += latencyMs;
  maxLatencyMs = Math.max(maxLatencyMs, latencyMs);
  if (statusCode >= 400) totalErrors += 1;

  const route = getOrCreateRouteMetrics(routeKey);
  route.requests += 1;
  route.totalLatencyMs += latencyMs;
  route.maxLatencyMs = Math.max(route.maxLatencyMs, latencyMs);
  if (statusCode >= 400) route.errors += 1;
}

export function getApiMetricsSnapshot() {
  const routeSummary = [...routes.entries()]
    .map(([route, metrics]) => {
      const avgLatencyMs = metrics.requests > 0 ? metrics.totalLatencyMs / metrics.requests : 0;
      const errorRate = metrics.requests > 0 ? metrics.errors / metrics.requests : 0;
      return {
        route,
        requests: metrics.requests,
        errors: metrics.errors,
        errorRate,
        avgLatencyMs,
        maxLatencyMs: metrics.maxLatencyMs
      };
    })
    .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)
    .slice(0, 5);

  return {
    requests: totalRequests,
    errors: totalErrors,
    errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    avgLatencyMs: totalRequests > 0 ? totalLatencyMs / totalRequests : 0,
    maxLatencyMs,
    slowestRoutes: routeSummary
  };
}

export function resetApiMetrics() {
  routes.clear();
  totalRequests = 0;
  totalErrors = 0;
  totalLatencyMs = 0;
  maxLatencyMs = 0;
}

export function toPrometheusMetrics(marketMetrics?: {
  marketDataFetchCount?: number;
  marketDataFetchFailures?: number;
  newsFetchCount?: number;
  newsFetchFailures?: number;
}) {
  const snapshot = getApiMetricsSnapshot();
  const lines = [
    '# TYPE api_requests_total counter',
    `api_requests_total ${snapshot.requests}`,
    '# TYPE api_errors_total counter',
    `api_errors_total ${snapshot.errors}`,
    '# TYPE api_error_rate gauge',
    `api_error_rate ${snapshot.errorRate}`,
    '# TYPE api_latency_avg_ms gauge',
    `api_latency_avg_ms ${snapshot.avgLatencyMs}`,
    '# TYPE api_latency_max_ms gauge',
    `api_latency_max_ms ${snapshot.maxLatencyMs}`
  ];

  if (marketMetrics) {
    lines.push(
      '# TYPE market_data_fetch_total counter',
      `market_data_fetch_total ${marketMetrics.marketDataFetchCount || 0}`,
      '# TYPE market_data_fetch_failures_total counter',
      `market_data_fetch_failures_total ${marketMetrics.marketDataFetchFailures || 0}`,
      '# TYPE news_fetch_total counter',
      `news_fetch_total ${marketMetrics.newsFetchCount || 0}`,
      '# TYPE news_fetch_failures_total counter',
      `news_fetch_failures_total ${marketMetrics.newsFetchFailures || 0}`
    );
  }

  return `${lines.join('\n')}\n`;
}
