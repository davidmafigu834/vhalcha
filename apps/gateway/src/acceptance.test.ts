import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@vhalcha/database/testing';
import type { AppDatabase } from '@vhalcha/database';
import { createMockEmbeddingProvider } from '@vhalcha/knowledge';
import { MockModelProvider } from '@vhalcha/providers';
import { MemoryRedis } from '@vhalcha/redis';
import { runV1Acceptance } from './acceptance-flow';
import { createMetrics } from './metrics';
import { buildServer } from './server';

describe('v1 acceptance harness', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length) {
      await closers.pop()?.();
    }
  });

  it('proves the gateway flow with the mock provider and no OpenAI call', async () => {
    const { db, client } = await createTestDatabase();
    const provider = new MockModelProvider();
    const redis = new MemoryRedis();
    const app = buildServer({
      db: db as unknown as AppDatabase,
      redis,
      provider,
      openAiApiKey: 'mock-provider',
      logger: pino({ level: 'silent' }),
      metrics: createMetrics(),
      embedder: createMockEmbeddingProvider(),
      routingRuntime: 'mock',
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    closers.push(async () => {
      await app.close();
      await client.close();
    });
    const stages = await runV1Acceptance({
      baseUrl: address,
      db: db as unknown as AppDatabase,
      provider,
      redis,
    });
    for (const stage of stages) {
      expect(stage.pass, `${stage.name}: ${stage.detail}`).toBe(true);
    }
  });
});
