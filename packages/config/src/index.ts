import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

function envFlag(fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') {
        return fallback;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
        return true;
      }
      if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
        return false;
      }
      return fallback;
    });
}

const commonSchema = z.object({
  VHALCHA_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SENTRY_DSN: z.string().optional().default(''),
  VHALCHA_DEV_MODEL: z.string().trim().min(1).default('gpt-4.1-mini'),
  KNOWLEDGE_STORAGE: z.enum(['local', 's3']).default('local'),
  KNOWLEDGE_S3_BUCKET: z.string().optional().default(''),
  KNOWLEDGE_S3_REGION: z.string().optional().default('us-east-1'),
  KNOWLEDGE_S3_ENDPOINT: z.string().optional().default(''),
  KNOWLEDGE_S3_ACCESS_KEY_ID: z.string().optional().default(''),
  KNOWLEDGE_S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  VHALCHA_SECRETS_KEY: z.string().optional().default(''),
  /**
   * Savings are hidden when catalogue price_verified_at is older than this many days.
   * 90 days is long enough for a published rate card and short enough that an unverified
   * year-old price is not shown as an optimisation benefit. Routing still uses the rate.
   */
  VHALCHA_MAX_PRICING_AGE_DAYS: z.coerce.number().int().positive().max(3650).default(90),
  /** Bounds a non-streaming or stream-open provider HTTP call. Default 60 seconds. */
  VHALCHA_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  /** Observes AI traffic when true. Does not by itself block requests. */
  GUARD_ENABLED: envFlag(true),
  /** Required before an organisation can leave monitor mode. Defaults off. */
  GUARD_PROTECT_MODE_ENABLED: envFlag(false),
  /** NVIDIA OpenShell is optional and stays off until a real adapter is configured. */
  GUARD_OPEN_SHELL_ENABLED: envFlag(false),
});

export const gatewayEnvSchema = commonSchema.extend({
  DATABASE_URL: nonEmpty,
  REDIS_URL: nonEmpty,
  OPENAI_API_KEY: z.string().optional().default(''),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  GOOGLE_API_KEY: z.string().optional().default(''),
  VHALCHA_GATEWAY_URL: z.string().default('http://localhost:3001'),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  GATEWAY_PORT: z.coerce.number().int().positive().default(3001),
  ALLOWED_ORIGINS: z.string().optional().default(''),
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /**
   * mock registers only the local mock adapter.
   * openai enables the real OpenAI, Anthropic and Google adapters.
   * It does not force every request onto OpenAI. Routing picks the provider.
   */
  VHALCHA_PROVIDER_MODE: z.enum(['openai', 'mock']).default('openai'),
  VHALCHA_EMBEDDING_MODE: z.enum(['openai', 'mock']).optional(),
});

export const dashboardEnvSchema = commonSchema.extend({
  DATABASE_URL: nonEmpty,
  SESSION_SECRET: z.string().min(32),
  VHALCHA_GATEWAY_URL: z.string().default('http://localhost:3001'),
  NEXT_PUBLIC_VHALCHA_APP_URL: z.string().default('http://localhost:3000'),
  NEXT_PUBLIC_VHALCHA_GATEWAY_URL: z.string().default('http://localhost:3001'),
});

export const workerEnvSchema = commonSchema.extend({
  DATABASE_URL: nonEmpty,
  WORKER_DATABASE_URL: z.string().optional().default(''),
  REDIS_URL: nonEmpty,
  VHALCHA_PROVIDER_MODE: z.enum(['openai', 'mock']).default('openai'),
  VHALCHA_EMBEDDING_MODE: z.enum(['openai', 'mock']).optional(),
});

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>;
export type DashboardConfig = z.infer<typeof dashboardEnvSchema>;
export type WorkerConfig = z.infer<typeof workerEnvSchema>;

/** True when VHALCHA_SECRETS_KEY can encrypt organisation provider credentials. */
export function byokStorageAvailable(keyMaterial: string | undefined): boolean {
  const trimmed = (keyMaterial ?? '').trim();
  if (!trimmed || insecureSecretPattern.test(trimmed)) {
    return false;
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32 && trimmed.length >= 32) {
    return true;
  }
  return Buffer.byteLength(trimmed) === 32;
}

export function loadEnvFile(startDirectory = process.cwd()): void {
  const candidates = [
    path.resolve(startDirectory, '.env'),
    path.resolve(startDirectory, '../../.env'),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      loadDotenv({ path: file });
      return;
    }
  }
}

function formatIssues(error: z.ZodError): string {
  const keys = error.issues.map((issue) => issue.path.join('.') || 'environment');
  return `Invalid environment configuration: ${keys.join(', ')}`;
}

const insecureSecretPattern = /dev-only|change-this|example|placeholder/i;
const blockedDatabaseUsers = new Set(['', 'postgres', 'vhalcha']);

function databaseUsername(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
}

function assertDatabaseRole(url: string, expectedUser: 'vhalcha_app' | 'vhalcha_worker') {
  const username = databaseUsername(url);
  if (blockedDatabaseUsers.has(username) || username !== expectedUser) {
    throw new Error('Invalid environment configuration: DATABASE_URL');
  }
}

function assertSessionSecret(secret: string) {
  const distinct = new Set(secret).size;
  if (secret.length < 32 || distinct < 16 || insecureSecretPattern.test(secret)) {
    throw new Error('Invalid environment configuration: SESSION_SECRET');
  }
}

function assertProductionSafety(data: {
  VHALCHA_ENV: string;
  DATABASE_URL?: string;
  REDIS_URL?: string;
  OPENAI_API_KEY?: string;
  VHALCHA_PROVIDER_MODE?: string;
  VHALCHA_EMBEDDING_MODE?: string;
  SESSION_SECRET?: string;
  databaseUser?: 'vhalcha_app' | 'vhalcha_worker';
  KNOWLEDGE_STORAGE?: string;
  KNOWLEDGE_S3_BUCKET?: string;
  VHALCHA_SECRETS_KEY?: string;
}) {
  if (data.VHALCHA_ENV !== 'production') {
    return;
  }
  if (data.REDIS_URL === 'memory://') {
    throw new Error('Invalid environment configuration: REDIS_URL');
  }
  if (data.VHALCHA_PROVIDER_MODE === 'mock') {
    throw new Error('Invalid environment configuration: VHALCHA_PROVIDER_MODE');
  }
  if (data.VHALCHA_EMBEDDING_MODE === 'mock') {
    throw new Error('Invalid environment configuration: VHALCHA_EMBEDDING_MODE');
  }
  if ('OPENAI_API_KEY' in data && !data.OPENAI_API_KEY) {
    throw new Error('Invalid environment configuration: OPENAI_API_KEY');
  }
  if (data.DATABASE_URL && data.databaseUser) {
    assertDatabaseRole(data.DATABASE_URL, data.databaseUser);
  }
  if (data.SESSION_SECRET !== undefined) {
    assertSessionSecret(data.SESSION_SECRET);
  }
  if (data.KNOWLEDGE_STORAGE !== undefined && data.KNOWLEDGE_STORAGE !== 's3') {
    throw new Error('Invalid environment configuration: KNOWLEDGE_STORAGE');
  }
  if (data.KNOWLEDGE_STORAGE === 's3' && !data.KNOWLEDGE_S3_BUCKET) {
    throw new Error('Invalid environment configuration: KNOWLEDGE_S3_BUCKET');
  }
  if (data.VHALCHA_SECRETS_KEY && insecureSecretPattern.test(data.VHALCHA_SECRETS_KEY)) {
    throw new Error('Invalid environment configuration: VHALCHA_SECRETS_KEY');
  }
}

function assertRuntimeDatabaseRole(envName: string, url: string, expectedUser: 'vhalcha_app' | 'vhalcha_worker') {
  if (envName === 'test') {
    return;
  }
  assertDatabaseRole(url, expectedUser);
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = gatewayEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error));
  }
  assertProductionSafety({ ...parsed.data, databaseUser: 'vhalcha_app' });
  assertRuntimeDatabaseRole(parsed.data.VHALCHA_ENV, parsed.data.DATABASE_URL, 'vhalcha_app');
  return parsed.data;
}

export function loadDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const parsed = dashboardEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error));
  }
  assertProductionSafety({ ...parsed.data, databaseUser: 'vhalcha_app' });
  assertRuntimeDatabaseRole(parsed.data.VHALCHA_ENV, parsed.data.DATABASE_URL, 'vhalcha_app');
  return parsed.data;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error));
  }
  assertProductionSafety({ ...parsed.data, databaseUser: 'vhalcha_worker' });
  const databaseUrl =
    parsed.data.VHALCHA_ENV === 'test'
      ? parsed.data.DATABASE_URL
      : parsed.data.WORKER_DATABASE_URL || parsed.data.DATABASE_URL;
  assertRuntimeDatabaseRole(parsed.data.VHALCHA_ENV, databaseUrl, 'vhalcha_worker');
  return { ...parsed.data, DATABASE_URL: databaseUrl };
}
