import { randomUUID } from 'crypto';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  requestId?: string;
  route?: string;
  method?: string;
  service?: string;
  [key: string]: unknown;
}

const parseLevel = (value: string | undefined): LogLevel => {
  const normalized = (value || 'info').toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return 'info';
};

const minimumLevel = parseLevel(process.env.LOG_LEVEL);
const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const shouldLog = (level: LogLevel): boolean => levelOrder[level] >= levelOrder[minimumLevel];

function write(level: LogLevel, message: string, context: LogContext = {}) {
  if (!shouldLog(level)) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, context?: LogContext) => write('debug', message, context),
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
  error: (message: string, context?: LogContext) => write('error', message, context)
};

export function getRequestId(headerValue?: string | string[]): string {
  if (Array.isArray(headerValue)) {
    return headerValue[0] || randomUUID();
  }

  return typeof headerValue === 'string' && headerValue.trim().length > 0
    ? headerValue.trim()
    : randomUUID();
}
