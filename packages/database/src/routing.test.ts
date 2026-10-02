import { describe, expect, it } from 'vitest';
import type { AppDatabase } from './client';
import { createRepositories } from './repositories';
import { createRoutingRepository } from './routing';
import { createTestDatabase } from './testing/harness';

describe('routing tenant isolation', () => {
  it('hides another organisation routing decision from the application role', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const routing = createRoutingRepository(appDb);
    const orgA = await repos.organisations.create({ name: 'Route A', slug: 'route-a' });
    const orgB = await repos.organisations.create({ name: 'Route B', slug: 'route-b' });
    const envA = await repos.environments.create({ organisationId: orgA.id, name: 'Development', type: 'development' });
    await repos.environments.create({ organisationId: orgB.id, name: 'Development', type: 'development' });
    const registered = await repos.registerAiSystem({
      organisationId: orgA.id,
      environmentId: envA.id,
      name: 'Support',
      description: '',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: true,
    });
    const requestId = crypto.randomUUID();
    await repos.requests.create({
      id: requestId,
      organisationId: orgA.id,
      aiSystemId: registered.system.id,
      environmentId: envA.id,
      virtualApiKeyId: registered.key!.record.id,
      provider: 'mock',
      model: 'economy-model',
      status: 'pending',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await routing.recordDecision({
      organisationId: orgA.id,
      requestId,
      aiSystemId: registered.system.id,
      routingMode: 'optimised',
      routingStrategy: 'cost',
      selectedProvider: 'mock',
      selectedModel: 'economy-model',
      selectedModelId: '11111111-1111-4111-8111-111111111111',
      candidateCount: 1,
      complexity: 'low',
      risk: 'low',
      estimatedInputTokens: 10,
      estimatedOutputTokens: 20,
      estimatedSelectedCost: 0.001,
      estimatedBaselineCost: 0.01,
      estimatedSavings: 0.009,
      decisionReason: { reasons: ['test'] },
    });
    await client.exec('set role vhalcha_app');
    const hidden = await client.query('select id from routing_decisions');
    expect(hidden.rows).toHaveLength(0);
    const own = await routing.findByRequest(orgA.id, requestId);
    expect(own?.selectedModel).toBe('economy-model');
    const foreign = await routing.savingsSummary(orgB.id, new Date('2020-01-01'), new Date('2100-01-01'));
    expect(foreign.decisions).toBe(0);
    await routing.recordAttempt({
      organisationId: orgA.id,
      requestId,
      attemptNumber: 1,
      provider: 'mock',
      model: 'economy-model',
      reason: 'selected',
      status: 'succeeded',
      inputTokens: 12,
      outputTokens: 8,
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.03,
      billable: true,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await client.exec('set role vhalcha_app');
    const hiddenAttempts = await client.query('select id from request_provider_attempts');
    expect(hiddenAttempts.rows).toHaveLength(0);
    const ownAttempts = await routing.listAttempts(orgA.id, requestId);
    expect(ownAttempts).toHaveLength(1);
    expect(Number(ownAttempts[0]?.actualCostUsd)).toBeCloseTo(0.03, 6);
    const foreignAttempts = await routing.listAttempts(orgB.id, requestId);
    expect(foreignAttempts).toHaveLength(0);
    await client.close();
  });

  it('keeps a single active provider connection for an organisation environment and provider', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Keys', slug: 'keys-org' });
    const env = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
    await repos.providerConnections.connectOrganisation({
      organisationId: org.id,
      environmentId: env.id,
      provider: 'openai',
      name: 'First',
      encryptedCredentials: 'v1.ciphertext',
    });
    await repos.providerConnections.connectOrganisation({
      organisationId: org.id,
      environmentId: env.id,
      provider: 'openai',
      name: 'Second',
      encryptedCredentials: 'v1.ciphertext-2',
    });
    const active = await repos.providerConnections.list(org.id);
    expect(active.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(active.find((row) => row.status === 'active')?.name).toBe('Second');
    expect(active.find((row) => row.status === 'active')?.verificationStatus).toBe('unverified');
    await client.close();
  });
});
