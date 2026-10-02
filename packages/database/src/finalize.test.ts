import { describe, expect, it } from 'vitest';
import { auditActions } from '@vhalcha/audit';
import { createRepositories, type AppDatabase } from './index';
import { budgetReservations } from './schema';
import { createTestDatabase } from './testing/harness';

describe('gateway finalization', () => {
  it('does not double count usage or the completion audit when retried', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Acme', slug: `finalize-${crypto.randomUUID().slice(0, 8)}` });
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
      status: 'pending',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    const input = {
      organisationId: org.id,
      requestId: request.id,
      aiSystemId: registered.system.id,
      virtualApiKeyId: registered.key?.record.id ?? '',
      completedAt: new Date(),
      requestPatch: { status: 'succeeded', httpStatus: 200, policyResult: 'allowed' },
      usage: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0.25,
        pricingKnown: true,
      },
      audit: {
        organisationId: org.id,
        environmentId: environment.id,
        actorType: 'api' as const,
        actorId: registered.key?.record.id ?? '',
        action: auditActions.requestCompleted,
        resourceType: 'request',
        resourceId: request.id,
        result: 'success' as const,
        severity: 'info' as const,
        requestId: request.id,
        metadata: { total_tokens: 15, cost_usd: 0.25 },
      },
    };
    const first = await repos.finalizeGatewayRequest(input);
    const second = await repos.finalizeGatewayRequest(input);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await repos.usage.list(org.id)).toHaveLength(1);
    const audits = await repos.audit.list(org.id);
    expect(audits.filter((event) => event.action === auditActions.requestCompleted)).toHaveLength(1);
    await expect(
      repos.usage.create({
        organisationId: org.id,
        aiSystemId: registered.system.id,
        requestId: request.id,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 1,
      }),
    ).rejects.toThrow();
    expect(await repos.usage.list(org.id)).toHaveLength(1);
    await client.close();
  });

  it('expires a hold when the provider was never started', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Acme', slug: `expire-${crypto.randomUUID().slice(0, 8)}` });
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
      status: 'pending',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await appDb.insert(budgetReservations).values({
      id: crypto.randomUUID(),
      organisationId: org.id,
      aiSystemId: registered.system.id,
      requestId: request.id,
      budgetId: registered.budget.id,
      reservedUsd: '0.05000000',
      status: 'reserved',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await repos.budgetReservations.expireDue(new Date())).toBe(1);
    expect((await repos.budgetReservations.list(org.id))[0]?.status).toBe('expired');
    expect(await repos.usage.list(org.id)).toHaveLength(0);
    await client.close();
  });

  it('keeps the reserved amount when a provider call was started and later replaces it once', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Acme', slug: `reconcile-${crypto.randomUUID().slice(0, 8)}` });
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
      status: 'pending',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await repos.requests.markProviderStarted(org.id, request.id);
    await appDb.insert(budgetReservations).values({
      id: crypto.randomUUID(),
      organisationId: org.id,
      aiSystemId: registered.system.id,
      requestId: request.id,
      budgetId: registered.budget.id,
      reservedUsd: '0.05000000',
      status: 'reserved',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await repos.budgetReservations.expireDue(new Date())).toBe(1);
    expect((await repos.requests.findById(org.id, request.id))?.status).toBe('reconciliation_required');
    expect(Number((await repos.usage.list(org.id))[0]?.costUsd)).toBeCloseTo(0.05, 6);
    expect((await repos.budgetReservations.list(org.id))[0]?.status).toBe('finalized');
    const finalized = await repos.finalizeGatewayRequest({
      organisationId: org.id,
      requestId: request.id,
      aiSystemId: registered.system.id,
      virtualApiKeyId: registered.key?.record.id ?? '',
      completedAt: new Date(),
      requestPatch: { status: 'succeeded', httpStatus: 200, policyResult: 'allowed' },
      usage: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        costUsd: 0.02,
        pricingKnown: true,
      },
      audit: {
        organisationId: org.id,
        environmentId: environment.id,
        actorType: 'api',
        actorId: registered.key?.record.id ?? '',
        action: auditActions.requestCompleted,
        resourceType: 'request',
        resourceId: request.id,
        result: 'success',
        severity: 'info',
        requestId: request.id,
        metadata: { total_tokens: 14, cost_usd: 0.02 },
      },
    });
    expect(finalized.duplicate).toBe(false);
    const usage = await repos.usage.list(org.id);
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]?.costUsd)).toBeCloseTo(0.02, 6);
    expect((await repos.requests.findById(org.id, request.id))?.status).toBe('succeeded');
    await client.close();
  });
});
