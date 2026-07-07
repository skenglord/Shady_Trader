/**
 * Shared API client — safeFetch with two-layer LRU cache, 5s TTL, 100-entry cap,
 * in-flight dedup, and token-store integration.
 *
 * Extracted from the former App.tsx monolith (T12). The cache and dedup logic
 * are identical to the original inline implementation. Token selection is driven
 * by the T2 token store (src/auth/tokenStore.ts): admin token for admin endpoints,
 * trader token for everything else.
 */
import { getAdminToken, getTraderToken } from '../auth/tokenStore';

const APP_URL = '';

// Token helpers — read the token store at call-time so the latest value is used.
function ADMIN_TOKEN(): string { return getAdminToken() || ''; }
function TRADER_TOKEN(): string { return getTraderToken() || ''; }

export { APP_URL };

// ---------------------------------------------------------------------------
// Two-layer cache + in-flight dedup (identical behaviour to original App.tsx)
// ---------------------------------------------------------------------------

const inflightRequests = new Map<string, Promise<{ ok: boolean; data?: any; error?: string }>>();
const responseCache = new Map<string, { ts: number; data: any }>();
const CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 100;

function cacheGet(url: string) {
  const entry = responseCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= CACHE_TTL_MS) {
    responseCache.delete(url);
    return undefined;
  }
  // Refresh LRU position
  responseCache.delete(url);
  responseCache.set(url, entry);
  return entry;
}

function cacheSet(url: string, data: any) {
  responseCache.set(url, { ts: Date.now(), data });
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey === undefined) break;
    responseCache.delete(oldestKey);
  }
}

function cacheInvalidate(urlPrefix: string) {
  for (const key of responseCache.keys()) {
    if (key === urlPrefix || key.startsWith(urlPrefix)) {
      responseCache.delete(key);
    }
  }
}

// Endpoints that require the admin token (all others use the trader token).
const ADMIN_PATHS = ['/settings', '/risk-configs', '/start', '/stop', '/kill', '/backtest', '/optimize', '/import-csv', '/ml/', '/freqtrade/', '/mc/'];

export async function safeFetch(url: string, options?: RequestInit): Promise<{ ok: boolean; data?: any; error?: string }> {
  const method = options?.method?.toUpperCase() || 'GET';
  if (method === 'GET') {
    const cached = cacheGet(url);
    if (cached) {
      return { ok: true, data: cached.data };
    }
    const inflight = inflightRequests.get(url);
    if (inflight) return inflight;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> || {}),
  };
  if (url.includes('/api/')) {
    const isAdminCall = ADMIN_PATHS.some(p => url.includes(p));
    const token = isAdminCall ? ADMIN_TOKEN() : TRADER_TOKEN();
    if (token && !token.includes('PLACEHOLDER')) {
      headers['x-api-token'] = token;
    }
  }

  const request = (async () => {
    try {
      const res = await fetch(url, { ...options, headers });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 100)}` };
      }
      try {
        const data = JSON.parse(text);
        if (method === 'GET') {
          cacheSet(url, data);
        }
        return { ok: true, data };
      } catch {
        return { ok: true, data: text };
      }
    } catch (e: any) {
      return { ok: false, error: e.message || 'Network error' };
    } finally {
      if (method === 'GET') {
        inflightRequests.delete(url);
      }
    }
  })();

  if (method === 'GET') {
    inflightRequests.set(url, request);
  }
  return request;
}

// Static helpers (same API surface as the original).
(safeFetch as any).invalidate = (urlPrefix: string) => cacheInvalidate(urlPrefix);
(safeFetch as any).clearCache = () => {
  responseCache.clear();
  inflightRequests.clear();
};

export const invalidate = (urlPrefix: string) => cacheInvalidate(urlPrefix);
export const clearCache = () => {
  responseCache.clear();
  inflightRequests.clear();
};

// ---------------------------------------------------------------------------
// Token helpers (re-exported so components can build headers for raw fetch
// calls that bypass safeFetch — e.g. POST mutations in the original App.tsx)
// ---------------------------------------------------------------------------

export function adminToken(): string { return ADMIN_TOKEN(); }
export function traderToken(): string { return TRADER_TOKEN(); }

// Debug logger — only logs in development mode (kept identical to original)
const IS_DEV = import.meta.env?.DEV ?? (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
export const debug = {
  log: (...args: any[]) => { if (IS_DEV) console.log(...args); },
  warn: (...args: any[]) => { if (IS_DEV) console.warn(...args); },
  error: (...args: any[]) => { console.error(...args); },
  info: (...args: any[]) => { if (IS_DEV) console.info(...args); },
};
