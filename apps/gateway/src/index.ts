import { loadEnvFile, loadGatewayConfig } from '@vhalcha/config';
import { createDatabase } from '@vhalcha/database';
import { createLogger, initErrorTracking } from '@vhalcha/logger';
import { createEmbeddingProvider, embeddingModeFromEnv } from '@vhalcha/knowledge';
import { createProviderRegistry } from '@vhalcha/providers';
import { createRedisClient } from '@vhalcha/redis';
import { createMetrics } from './metrics';
import { buildServer } from './server';

loadEnvFile();
const config = loadGatewayConfig();
const logger = createLogger('gateway', config.LOG_LEVEL);
const tracker = await initErrorTracking(config.SENTRY_DSN || undefined);
const { db, pool } = createDatabase(config.DATABASE_URL);
const redis = createRedisClient(config.REDIS_URL);
const includeMock = config.VHALCHA_PROVIDER_MODE === 'mock';
const providers = createProviderRegistry({
  timeoutMs: config.VHALCHA_PROVIDER_TIMEOUT_MS,
  includeMock,
});
const app = buildServer(
  {
    db,
    redis,
    providers,
    provider: providers.get(includeMock ? 'mock' : 'openai') ?? undefined,
    openAiApiKey: includeMock ? 'mock-provider' : config.OPENAI_API_KEY,
    platformKeys: {
      openai: includeMock ? 'mock-provider' : config.OPENAI_API_KEY,
      anthropic: config.ANTHROPIC_API_KEY,
      google: config.GOOGLE_API_KEY,
    },
    logger,
    metrics: createMetrics(),
    tracker,
    routingRuntime: includeMock ? 'mock' : 'multi',
    guardEnabled: config.GUARD_ENABLED,
    protectModeEnabled: config.GUARD_PROTECT_MODE_ENABLED,
    maxPricingAgeDays: config.VHALCHA_MAX_PRICING_AGE_DAYS,
    embedder:
      embeddingModeFromEnv() === 'mock' || config.OPENAI_API_KEY
        ? createEmbeddingProvider({
            mode: embeddingModeFromEnv(),
            apiKey: config.OPENAI_API_KEY,
          })
        : undefined,
  },
  {
    bodyLimit: config.REQUEST_BODY_LIMIT_BYTES,
    allowedOrigins: config.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
  },
);

const address = await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });
logger.info({ address }, 'gateway listening');

async function shutdown() {
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
