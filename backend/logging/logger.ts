import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { LogRotator, TimeBasedRotator } from './rotation.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  requestId?: string;
  route?: string;
  method?: string;
  service?: string;
  [key: string]: unknown;
}

const parseLevel = (value: string | undefined): LogLevel => {
  // Default to 'info' in production, 'debug' in development
  const defaultLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
  const normalized = (value || defaultLevel).toLowerCase();
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

// Log rotation setup
const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const logFile = path.join(logDir, 'trading-system.log');

// Ensure log directory exists
try {
  if (!require('fs').existsSync(logDir)) {
    require('fs').mkdirSync(logDir, { recursive: true });
  }
} catch (e) {
  // If we can't create log directory, fall back to stdout/stderr only
}

const sizeRotator = new LogRotator(logFile, {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  compress: false
});

const timeRotator = new TimeBasedRotator(logFile, {
  maxFiles: 7, // Keep 7 days of logs
  compress: false
});

// Start periodic checks
sizeRotator.startPeriodicCheck(60000); // Check every minute
timeRotator.checkAndRotate(); // Check on startup

function writeLogLine(line: string) {
  // Write to stdout/stderr
  if (line.includes('"level":"error"')) {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }

  // Write to file with rotation
  try {
    if (require('fs').existsSync(logDir)) {
      // Check for time-based rotation
      timeRotator.checkAndRotate();

      // Check for size-based rotation
      if (sizeRotator.needsRotation()) {
        sizeRotator.rotate();
      }

      require('fs').appendFileSync(logFile, `${line}\n`);
    }
  } catch (e) {
    // If file write fails, continue with stdout/stderr only
  }
}

function write(level: LogLevel, message: string, context: LogContext = {}) {
  if (!shouldLog(level)) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    service: context.service || 'trading-system',
    pid: process.pid,
    hostname: os.hostname(),
    ...context
  };

  const line = JSON.stringify(payload);
  writeLogLine(line);
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
