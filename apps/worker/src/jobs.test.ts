import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createRepositories, virtualApiKeys, type AppDatabase } from '@vhalcha/database';
import { createTestDatabase } from '@vhalcha/database/testing';
import { cleanupExpiredRecords, rebuildSpendSummaries } from './jobs';

describe('worker jobs', () => {
  it('aggregates usage into a monthly spend summary and expires old keys', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Acme', slug: 'acme-worker', timezone: 'UTC' });
    const environment = await repos.environments.create({
      organisationId: org.id,
      name: 'Development',
      type: 'development',
    });
    const registered = await repos.registerAiSystem({
      organisationId: org.id,
      environmentId: environment.id,
      name: 'Customer Support AI',
      description: 'test',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 25,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: true,
    });
    const request = await repos.requests.create({
      organisationId: org.id,
      aiSystemId: registered.system.id,
      environmentId: environment.id,
      virtualApiKeyId: registered.key?.record.id ?? '',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'succeeded',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await repos.usage.create({
      organisationId: org.id,
      aiSystemId: registered.system.id,
      requestId: request.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 1.25,
    });
    expect(await rebuildSpendSummaries(appDb, 'monthly', new Date())).toBe(1);

    const expired = await repos.apiKeys.insert({
      organisationId: org.id,
      aiSystemId: registered.system.id,
      environmentId: environment.id,
      name: 'expiring',
      environmentType: 'development',
    });
    await appDb
      .update(virtualApiKeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(virtualApiKeys.id, expired.record.id));
    const cleaned = await cleanupExpiredRecords(appDb, new Date());
    expect(cleaned.expiredKeys).toBe(1);
    await client.close();
  });
});
