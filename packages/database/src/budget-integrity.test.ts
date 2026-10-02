import { describe, expect, it } from 'vitest';
import { periodBounds } from '@vhalcha/budgets';
import type { AppDatabase } from './client';
import { BudgetReservationRejected, createRepositories } from './repositories';
import { createTestDatabase } from './testing/harness';

async function fixture() {
  const { db, client } = await createTestDatabase();
  const repos = createRepositories(db as unknown as AppDatabase);
  const org = await repos.organisations.create({ name: 'Budget Org', slug: `budget-${crypto.randomUUID().slice(0, 8)}`, timezone: 'UTC' });
  const environment = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
  const systemA = await repos.registerAiSystem({
    organisationId: org.id,
    environmentId: environment.id,
    name: 'System A',
    description: '',
    type: 'assistant',
    riskLevel: 'low',
    monthlyBudgetUsd: 10_000,
    modelPattern: 'gpt-4.1-mini',
    requestsPerMinute: 60,
    generateKey: true,
  });
  const systemB = await repos.registerAiSystem({
    organisationId: org.id,
    environmentId: environment.id,
    name: 'System B',
    description: '',
    type: 'assistant',
    riskLevel: 'low',
    monthlyBudgetUsd: 10_000,
    modelPattern: 'gpt-4.1-mini',
    requestsPerMinute: 60,
    generateKey: true,
  });
  return { client, repos, org, environment, systemA, systemB };
}

async function spend(
  repos: Awaited<ReturnType<typeof fixture>>['repos'],
  input: { organisationId: string; aiSystemId: string; environmentId: string; virtualApiKeyId: string; costUsd: number },
) {
  const request = await repos.requests.create({
    organisationId: input.organisationId,
    aiSystemId: input.aiSystemId,
    environmentId: input.environmentId,
    virtualApiKeyId: input.virtualApiKeyId,
    provider: 'mock',
    model: 'economy-model',
    status: 'succeeded',
    policyResult: 'allowed',
    startedAt: new Date(),
  });
  await repos.usage.create({
    organisationId: input.organisationId,
    aiSystemId: input.aiSystemId,
    requestId: request.id,
    provider: 'mock',
    model: 'economy-model',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    costUsd: input.costUsd,
  });
}

function windows(budgetIds: string[], now: Date) {
  return budgetIds.map((budgetId) => {
    const bounds = periodBounds('monthly', 'UTC', now);
    return { budgetId, start: bounds.start, end: bounds.end };
  });
}

describe('fallback budget scope', () => {
  it('rejects an organisation-scoped raise that system spend alone would allow', async () => {
    const ctx = await fixture();
    const now = new Date();
    const orgBudget = await ctx.repos.budgets.create({
      organisationId: ctx.org.id,
      name: 'Organisation',
      period: 'monthly',
      amountUsd: 100,
      hardLimit: true,
      action: 'block',
    });
    await spend(ctx.repos, {
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemB.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemB.key!.record.id,
      costUsd: 90,
    });
    await spend(ctx.repos, {
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemA.key!.record.id,
      costUsd: 5,
    });
    const requestId = crypto.randomUUID();
    await ctx.repos.requests.create({
      id: requestId,
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemA.key!.record.id,
      provider: 'mock',
      model: 'economy-model',
      status: 'pending',
      policyResult: 'allowed',
      startedAt: now,
    });
    const applicable = await ctx.repos.budgets.applicable(ctx.org.id, ctx.systemA.system.id, ctx.environment.id);
    const periods = windows(applicable.map((budget) => budget.id), now);
    await ctx.repos.budgetReservations.reserve({
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      requestId,
      estimatedUsd: 1,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
      periods,
    });
    await expect(
      ctx.repos.budgetReservations.raise({
        organisationId: ctx.org.id,
        aiSystemId: ctx.systemA.system.id,
        environmentId: ctx.environment.id,
        requestId,
        estimatedUsd: 6,
        now,
        periods,
      }),
    ).rejects.toBeInstanceOf(BudgetReservationRejected);
    expect(orgBudget.amountUsd).toBeTruthy();
    await ctx.client.close();
  });

  it('rejects an environment-scoped raise that system spend alone would allow', async () => {
    const ctx = await fixture();
    const now = new Date();
    await ctx.repos.budgets.create({
      organisationId: ctx.org.id,
      environmentId: ctx.environment.id,
      name: 'Environment',
      period: 'monthly',
      amountUsd: 100,
      hardLimit: true,
      action: 'block',
    });
    await spend(ctx.repos, {
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemB.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemB.key!.record.id,
      costUsd: 90,
    });
    await spend(ctx.repos, {
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemA.key!.record.id,
      costUsd: 5,
    });
    const requestId = crypto.randomUUID();
    await ctx.repos.requests.create({
      id: requestId,
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemA.key!.record.id,
      provider: 'mock',
      model: 'economy-model',
      status: 'pending',
      policyResult: 'allowed',
      startedAt: now,
    });
    const applicable = await ctx.repos.budgets.applicable(ctx.org.id, ctx.systemA.system.id, ctx.environment.id);
    const periods = windows(applicable.map((budget) => budget.id), now);
    await ctx.repos.budgetReservations.reserve({
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      requestId,
      estimatedUsd: 1,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
      periods,
    });
    await expect(
      ctx.repos.budgetReservations.raise({
        organisationId: ctx.org.id,
        aiSystemId: ctx.systemA.system.id,
        environmentId: ctx.environment.id,
        requestId,
        estimatedUsd: 6,
        now,
        periods,
      }),
    ).rejects.toBeInstanceOf(BudgetReservationRejected);
    await ctx.client.close();
  });

  it('allows a system-scoped raise inside the system hard limit and rejects one past it', async () => {
    const ctx = await fixture();
    const now = new Date();
    await ctx.repos.budgets.update(ctx.org.id, ctx.systemA.budget.id, { amountUsd: 100 });
    await spend(ctx.repos, {
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemA.key!.record.id,
      costUsd: 5,
    });
    const requestId = crypto.randomUUID();
    await ctx.repos.requests.create({
      id: requestId,
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.systemA.key!.record.id,
      provider: 'mock',
      model: 'economy-model',
      status: 'pending',
      policyResult: 'allowed',
      startedAt: now,
    });
    const applicable = await ctx.repos.budgets.applicable(ctx.org.id, ctx.systemA.system.id, ctx.environment.id);
    const periods = windows(applicable.map((budget) => budget.id), now);
    await ctx.repos.budgetReservations.reserve({
      organisationId: ctx.org.id,
      aiSystemId: ctx.systemA.system.id,
      environmentId: ctx.environment.id,
      requestId,
      estimatedUsd: 1,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
      periods,
    });
    await expect(
      ctx.repos.budgetReservations.raise({
        organisationId: ctx.org.id,
        aiSystemId: ctx.systemA.system.id,
        environmentId: ctx.environment.id,
        requestId,
        estimatedUsd: 6,
        now,
        periods,
      }),
    ).resolves.toMatchObject({ estimatedUsd: 6 });
    await expect(
      ctx.repos.budgetReservations.raise({
        organisationId: ctx.org.id,
        aiSystemId: ctx.systemA.system.id,
        environmentId: ctx.environment.id,
        requestId,
        estimatedUsd: 96,
        now,
        periods,
      }),
    ).rejects.toBeInstanceOf(BudgetReservationRejected);
    await ctx.client.close();
  });

  it('does not let two concurrent raises expand past the remaining budget', async () => {
    const ctx = await fixture();
    const now = new Date();
    await ctx.repos.budgets.update(ctx.org.id, ctx.systemA.budget.id, { amountUsd: 100 });
    const applicable = await ctx.repos.budgets.applicable(ctx.org.id, ctx.systemA.system.id, ctx.environment.id);
    const periods = windows(applicable.map((budget) => budget.id), now);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const requestId of ids) {
      await ctx.repos.requests.create({
        id: requestId,
        organisationId: ctx.org.id,
        aiSystemId: ctx.systemA.system.id,
        environmentId: ctx.environment.id,
        virtualApiKeyId: ctx.systemA.key!.record.id,
        provider: 'mock',
        model: 'economy-model',
        status: 'pending',
        policyResult: 'allowed',
        startedAt: now,
      });
      await ctx.repos.budgetReservations.reserve({
        organisationId: ctx.org.id,
        aiSystemId: ctx.systemA.system.id,
        environmentId: ctx.environment.id,
        requestId,
        estimatedUsd: 10,
        now,
        expiresAt: new Date(now.getTime() + 60_000),
        periods,
      });
    }
    const results = await Promise.all(
      ids.map(async (requestId) => {
        try {
          await ctx.repos.budgetReservations.raise({
            organisationId: ctx.org.id,
            aiSystemId: ctx.systemA.system.id,
            environmentId: ctx.environment.id,
            requestId,
            estimatedUsd: 80,
            now,
            periods,
          });
          return 'raised';
        } catch (error) {
          if (error instanceof BudgetReservationRejected) {
            return 'rejected';
          }
          throw error;
        }
      }),
    );
    expect(results.filter((result) => result === 'raised')).toHaveLength(1);
    expect(results.filter((result) => result === 'rejected')).toHaveLength(1);
    await ctx.client.close();
  });
});
