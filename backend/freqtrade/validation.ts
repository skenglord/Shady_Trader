import { randomBytes } from 'crypto';

export const FREQTRADE_MAX_TIMERANGE_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function normalizeFreqtradeTimerange(timerange: { start?: string; end?: string } | undefined, label = 'Freqtrade timerange'): { start: string; end: string } {
  const start = normalizeTimerangePart(timerange?.start, `${label}.start`);
  const end = normalizeTimerangePart(timerange?.end, `${label}.end`);
  const startMs = parseTimerangePart(start);
  const endMs = parseTimerangePart(end);

  if (!startMs || !endMs) {
    throw new Error(`${label} must use YYYYMMDD or YYYY-MM-DD dates`);
  }

  if (endMs <= startMs) {
    throw new Error(`${label}.end must be after ${label}.start`);
  }

  const days = Math.ceil((endMs - startMs) / MS_PER_DAY);
  if (days > FREQTRADE_MAX_TIMERANGE_DAYS) {
    throw new Error(`${label} cannot exceed ${FREQTRADE_MAX_TIMERANGE_DAYS} days`);
  }

  return { start, end };
}

export function normalizeValidateTolerance(value: unknown): number {
  const tolerance = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
    throw new Error('Validation tolerance must be between 0 and 1');
  }
  return tolerance;
}

export function resolveFreqtradeApiEnv(): Record<string, string> {
  const username = process.env.FREQTRADE__API_SERVER__USERNAME || process.env.FREQTRADE_API_USER || '';
  const password = process.env.FREQTRADE__API_SERVER__PASSWORD || process.env.FREQTRADE_API_PASS || '';

  if (!username || !password) {
    throw new Error('FREQTRADE_API_USER and FREQTRADE_API_PASS must be configured for Freqtrade jobs');
  }

  return {
    FREQTRADE__API_SERVER__USERNAME: username,
    FREQTRADE__API_SERVER__PASSWORD: password,
  };
}

export function buildFreqtradeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FREQTRADE__EXCHANGE__NAME: process.env.FREQTRADE__EXCHANGE__NAME || process.env.EXCHANGE_NAME || 'binance',
    FREQTRADE__EXCHANGE__KEY: process.env.FREQTRADE__EXCHANGE__KEY || process.env.EXCHANGE_API_KEY || '',
    FREQTRADE__EXCHANGE__SECRET: process.env.FREQTRADE__EXCHANGE__SECRET || process.env.EXCHANGE_API_SECRET || '',
    FREQTRADE__EXCHANGE__PASSWORD: process.env.FREQTRADE__EXCHANGE__PASSWORD || process.env.EXCHANGE_API_PASSWORD || '',
    FREQTRADE__API_SERVER__JWT_SECRET_KEY:
      process.env.FREQTRADE__API_SERVER__JWT_SECRET_KEY ||
      process.env.FREQTRADE_JWT_SECRET_KEY ||
      randomBytes(32).toString('hex'),
    ...resolveFreqtradeApiEnv(),
  };
}

function normalizeTimerangePart(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }

  const normalized = trimmed.replace(/-/g, '');
  if (!/^\d{8}$/.test(normalized)) {
    throw new Error(`${label} must use YYYYMMDD or YYYY-MM-DD format`);
  }

  return normalized;
}

function parseTimerangePart(value: string): number | null {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = Date.UTC(year, month - 1, day);
  const date = new Date(parsed);
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  return valid ? parsed : null;
}
