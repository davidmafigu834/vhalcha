import { loadEnvFile, loadGatewayConfig } from '@vhalcha/config';
import { createDatabase } from '@vhalcha/database';
import { createLogger } from '@vhalcha/logger';
import { createMockEmbeddingProvider } from '@vhalcha/knowledge';
import { MockModelProvider, createProviderRegistry } from '@vhalcha/providers';
import { createRedisClient } from '@vhalcha/redis';
import { runV1Acceptance } from './acceptance-flow';
import { createMetrics } from './metrics';
import { buildServer } from './server';

loadEnvFile();
const config = loadGatewayConfig({
  ...process.env,
  VHALCHA_PROVIDER_MODE: 'mock',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'unused-by-mock',
});

if (config.VHALCHA_ENV === 'production') {
  console.error('FAIL production: the acceptance harness refuses to start');
  process.exit(1);
}

const provider = new MockModelProvider();
const providers = createProviderRegistry({ includeMock: true, overrides: { mock: provider, openai: provider } });
const { db, pool } = createDatabase(config.DATABASE_URL);
const redis = createRedisClient(config.REDIS_URL);
const app = buildServer(
  {
    db,
    redis,
    provider,
    providers,
    openAiApiKey: 'mock-provider',
    platformKeys: { openai: 'mock-provider' },
    logger: createLogger('acceptance', 'silent'),
    metrics: createMetrics(),
    embedder: createMockEmbeddingProvider(),
    routingRuntime: 'mock',
    maxPricingAgeDays: config.VHALCHA_MAX_PRICING_AGE_DAYS,
  },
  { allowedOrigins: [] },
);

const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
let failed = 0;
try {
  const stages = await runV1Acceptance({ baseUrl, db, provider, redis });
  for (const stage of stages) {
    const label = stage.pass ? 'PASS' : 'FAIL';
    if (!stage.pass) {
      failed += 1;
    }
    console.log(`${label} ${stage.name} — ${stage.detail}`);
  }
} catch (error) {
  failed += 1;
  const message = error instanceof Error ? error.message : 'Error';
  console.error(`FAIL harness — ${message.slice(0, 300)}`);
} finally {
  await app.close();
  await pool.end();
}

if (failed > 0) {
  console.error(`FAIL ${failed} stage(s)`);
  process.exit(1);
}
console.log('PASS acceptance harness');
process.exit(0);
