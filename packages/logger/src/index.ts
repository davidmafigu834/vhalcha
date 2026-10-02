import pino, { type Logger } from 'pino';

const SENSITIVE_KEY =
  /password|authorization|cookie|secret|(?:^|_)token(?:$|_)|api[-_]?key|credential|raw[-_]?key|key[-_]?hash|openai[-_]?api[-_]?key/i;
const VIRTUAL_KEY = /vh_(live|test)_[A-Za-z0-9_-]{20,}/g;
const PROVIDER_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(entry);
    }
    return output;
  }
  if (typeof value === 'string') {
    return value.replace(VIRTUAL_KEY, 'vh_$1_[redacted]').replace(PROVIDER_KEY, '[redacted]');
  }
  return value;
}

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'secret',
  'token',
  'rawKey',
  'keyHash',
  'OPENAI_API_KEY',
  '*.password',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.cookie',
  '*.secret',
  '*.token',
  '*.rawKey',
  '*.keyHash',
];

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name,
    level,
    base: { service: name, product: 'vhalcha' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: redactPaths,
      censor: '[redacted]',
    },
    formatters: {
      log(object) {
        return redactValue(object) as Record<string, unknown>;
      },
    },
  });
}

export interface ErrorTracker {
  captureException(error: unknown, context?: Record<string, string>): void;
}

export async function initErrorTracking(dsn: string | undefined): Promise<ErrorTracker> {
  if (!dsn) {
    return { captureException() {} };
  }
  try {
    const sentry = await import('@sentry/node');
    sentry.init({
      dsn,
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
    return {
      captureException(error, context) {
        const safeContext = redactValue(context ?? {}) as Record<string, string>;
        sentry.captureException(error, { extra: safeContext });
      },
    };
  } catch {
    return { captureException() {} };
  }
}

export interface GatewayLogFields {
  request_id: string;
  organisation_id?: string;
  ai_system_id?: string;
  provider?: string;
  model?: string;
  status?: string;
  latency_ms?: number;
}

export function logGatewayRequest(logger: Logger, fields: GatewayLogFields): void {
  logger.info(redactValue(fields) as GatewayLogFields, 'gateway request completed');
}
