import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';  // ESM-friendly: replaces `require('fs')` throughout this module
import { LogRotator, TimeBasedRotator } from './rotation.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  requestId?: string;
  route?: string;
  method?: string;
  service?: string;
  [key: string]: unknown;
}

/** Permissive variant for legacy call sites that pass non-LogContext values
 *  (strings, errors, ZodIssue[], etc.). Used as the runtime-accepted type
 *  for the logger's context argument; sanitization will coerce it. */
export type LogContextInput = LogContext | unknown;

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
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
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
    if (fs.existsSync(logDir)) {
      // Check for time-based rotation
      timeRotator.checkAndRotate();

      // Check for size-based rotation
      if (sizeRotator.needsRotation()) {
        sizeRotator.rotate();
      }

      fs.appendFileSync(logFile, `${line}\n`);
    } else {
      // Log directory vanished after startup — recreate it and retry.
      try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) { /* swallow */ }
    }
  } catch (e) {
    // Don't swallow write errors silently — surface them so broken file
    // rotation / permission issues are visible in dev and CI. Stdout output
    // continues regardless, so logging in production is never blocked.
    const err = e instanceof Error ? e : new Error(String(e));
    try { process.stderr.write(`[logger] file write failed: ${err.message} (path=${logFile})\n`); } catch (_) { /* swallow */ }
  }
}

function write(level: LogLevel, message: string, context: LogContextInput = {}) {
  if (!shouldLog(level)) return;

  // SECURITY: Sanitize sensitive fields from logs to prevent PII/secret leakage.
  const sanitizedContext = sanitizeContext(context);

  // In production, hash the hostname to avoid leaking internal hostnames.
  // In development, keep it for easier debugging.
  const hostname = process.env.NODE_ENV === 'production'
    ? hashHostname(os.hostname())
    : os.hostname();

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    service: (sanitizedContext as LogContext).service || 'trading-system',
    pid: process.pid,
    hostname,
    ...sanitizedContext
  };

  const line = JSON.stringify(payload);
  writeLogLine(line);
}

/**
 * Hash hostname for production log anonymization.
 * Returns a short, deterministic identifier that doesn't reveal the actual hostname.
 */
function hashHostname(hostname: string): string {
  // Simple, non-cryptographic hash for log anonymization
  // (not for security — just to prevent hostname disclosure in production logs)
  let hash = 0;
  for (let i = 0; i < hostname.length; i++) {
    const char = hostname.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `host-${Math.abs(hash).toString(36)}`;
}

/**
 * Remove sensitive fields from log context.
 * Strips password, token, secret, apiKey fields recursively.
 * Accepts any input (object, string, Error, array) and returns a safe object.
 */
function sanitizeContext(context: LogContextInput): LogContext {
  // Coerce non-object values into a wrapper so the rest of the function can
  // operate uniformly. Errors expose useful diagnostics as a 'value' key.
  if (context === null || context === undefined) return {};
  if (typeof context !== 'object') {
    return { value: String(context) };
  }
  if (context instanceof Error) {
    return { value: context.message, stack: context.stack };
  }
  if (Array.isArray(context)) {
    return { value: context as unknown as Record<string, unknown> };
  }
  const ctx = context as Record<string, any>;
  const sensitiveKeys = /password|token|secret|apikey|api_key|authorization|cookie|sessionid|jwt|bearer/i;
  const result: LogContext = {};

  for (const [key, value] of Object.entries(ctx)) {
    if (sensitiveKeys.test(key)) {
      result[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      result[key] = sanitizeContext(value);
    } else if (Array.isArray(value)) {
      // Arrays of typed objects (e.g. ZodIssue[]) need the same index-signature
      // escape hatch as the top-level coerce above.
      result[key] = value as unknown as Record<string, unknown>;
    } else if (typeof value === 'string' && value.length > 500) {
      // Truncate very long strings (likely stack traces or dumps)
      result[key] = value.substring(0, 500) + '...[truncated]';
    } else {
      result[key] = value;
    }
  }

  return result;
}

export const logger = {
  debug: (message: string, context?: LogContextInput) => write('debug', message, context),
  info: (message: string, context?: LogContextInput) => write('info', message, context),
  warn: (message: string, context?: LogContextInput) => write('warn', message, context),
  error: (message: string, context?: LogContextInput) => write('error', message, context)
};

export function getRequestId(headerValue?: string | string[]): string {
  if (Array.isArray(headerValue)) {
    return headerValue[0] || randomUUID();
  }

  return typeof headerValue === 'string' && headerValue.trim().length > 0
    ? headerValue.trim()
    : randomUUID();
}
