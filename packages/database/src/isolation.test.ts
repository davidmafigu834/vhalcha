import { describe, expect, it } from 'vitest';
import type { AppDatabase } from './client';
import { createRepositories } from './repositories';
import { createTestDatabase } from './testing/harness';

describe('tenant isolation', () => {
  it('prevents organisation A from reading organisation B control-plane records', async () => {
    const { db, client } = await createTestDatabase();
    const repos = createRepositories(db as unknown as AppDatabase);
    const orgA = await repos.organisations.create({ name: 'Organisation A', slug: 'org-a' });
    const orgB = await repos.organisations.create({ name: 'Organisation B', slug: 'org-b' });
    const envA = await repos.environments.create({
      organisationId: orgA.id,
      name: 'Development',
      type: 'development',
    });
    const envB = await repos.environments.create({
      organisationId: orgB.id,
      name: 'Development',
      type: 'development',
    });
    const registeredA = await repos.registerAiSystem({
      organisationId: orgA.id,
      environmentId: envA.id,
      name: 'Support A',
      description: 'Development seed',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 25,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: true,
    });
    const registeredB = await repos.registerAiSystem({
      organisationId: orgB.id,
      environmentId: envB.id,
      name: 'Support B',
      description: 'Development seed',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 25,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: true,
    });

    expect(await repos.aiSystems.findById(orgA.id, registeredB.system.id)).toBeNull();
    expect(await repos.apiKeys.findById(orgA.id, registeredB.key?.record.id ?? '')).toBeNull();
    expect((await repos.apiKeys.list(orgA.id)).map((key) => key.id)).toEqual([
      registeredA.key?.record.id,
    ]);
    expect((await repos.budgets.list(orgA.id)).map((budget) => budget.id)).not.toContain(
      registeredB.budget.id,
    );

    const request = await repos.requests.create({
      organisationId: orgB.id,
      aiSystemId: registeredB.system.id,
      environmentId: envB.id,
      virtualApiKeyId: registeredB.key?.record.id ?? '',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'succeeded',
      policyResult: 'allowed',
      startedAt: new Date(),
      completedAt: new Date(),
      httpStatus: 200,
    });
    expect(await repos.requests.findById(orgA.id, request.id)).toBeNull();

    await repos.usage.create({
      organisationId: orgB.id,
      aiSystemId: registeredB.system.id,
      requestId: request.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
    });
    expect(await repos.usage.list(orgA.id)).toEqual([]);

    const auditA = await repos.audit.list(orgA.id);
    expect(auditA.every((event) => event.organisationId === orgA.id)).toBe(true);
    expect(auditA.some((event) => event.resourceId === registeredB.system.id)).toBe(false);

    await client.close();
  });
});
