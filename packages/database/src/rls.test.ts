import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AppDatabase } from './client';
import { createRepositories } from './repositories';
import { budgetReservations } from './schema';
import { createTestDatabase } from './testing/harness';
import { usingTenant } from './tenant';

function rowIds(result: unknown): string[] {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<{ id?: string }> }).rows ?? []);
  return rows.map((row) => String(row.id));
}

describe('row level security', () => {
  it('keeps organisation A from reading, inserting, or updating organisation B', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const orgA = await repos.organisations.create({ name: 'Organisation A', slug: 'rls-a' });
    const orgB = await repos.organisations.create({ name: 'Organisation B', slug: 'rls-b' });
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
      description: 'A',
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
      description: 'B',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 25,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: true,
    });
    const requestB = crypto.randomUUID();
    await appDb.insert(budgetReservations).values({
      id: crypto.randomUUID(),
      organisationId: orgB.id,
      aiSystemId: registeredB.system.id,
      requestId: requestB,
      budgetId: registeredB.budget.id,
      reservedUsd: '1.00000000',
      status: 'reserved',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const reservationAId = crypto.randomUUID();
    await appDb.insert(budgetReservations).values({
      id: reservationAId,
      organisationId: orgA.id,
      aiSystemId: registeredA.system.id,
      requestId: crypto.randomUUID(),
      budgetId: registeredA.budget.id,
      reservedUsd: '1.00000000',
      status: 'reserved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await client.exec('set role vhalcha_app');

    const forgottenWhere = await usingTenant(appDb, orgA.id, async (tx) =>
      tx.execute(sql`select id from ai_systems`),
    );
    expect(rowIds(forgottenWhere)).toEqual([registeredA.system.id]);

    const directId = await usingTenant(appDb, orgA.id, async (tx) =>
      tx.execute(sql`select id from ai_systems where id = ${registeredB.system.id}::uuid`),
    );
    expect(rowIds(directId)).toEqual([]);

    await expect(
      usingTenant(appDb, orgA.id, async (tx) =>
        tx.execute(sql`
          insert into requests (
            id, organisation_id, ai_system_id, environment_id, virtual_api_key_id,
            provider, model, status, policy_result, started_at
          ) values (
            ${crypto.randomUUID()}::uuid,
            ${orgB.id}::uuid,
            ${registeredB.system.id}::uuid,
            ${envB.id}::uuid,
            ${registeredB.key?.record.id ?? crypto.randomUUID()}::uuid,
            'openai',
            'gpt-4.1-mini',
            'pending',
            'allowed',
            now()
          )
        `),
      ),
    ).rejects.toThrow();

    const updated = await usingTenant(appDb, orgA.id, async (tx) =>
      tx.execute(sql`
        update ai_systems
        set description = 'changed'
        where id = ${registeredB.system.id}::uuid
        returning id
      `),
    );
    expect(rowIds(updated)).toEqual([]);

    const reservations = await usingTenant(appDb, orgA.id, async (tx) =>
      tx.execute(sql`select id from budget_reservations`),
    );
    expect(rowIds(reservations)).toEqual([reservationAId]);

    const requestA = await repos.requests.create({
      organisationId: orgA.id,
      aiSystemId: registeredA.system.id,
      environmentId: envA.id,
      virtualApiKeyId: registeredA.key?.record.id ?? '',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'succeeded',
      policyResult: 'allowed',
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await repos.usage.create({
      organisationId: orgA.id,
      aiSystemId: registeredA.system.id,
      requestId: requestA.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0.01,
    });
    await expect(
      repos.usage.create({
        organisationId: orgA.id,
        aiSystemId: registeredA.system.id,
        requestId: requestA.id,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0.02,
      }),
    ).rejects.toThrow();
    const usageRows = await usingTenant(appDb, orgA.id, async (tx) =>
      tx.execute(sql`select id from usage_events`),
    );
    expect(rowIds(usageRows)).toHaveLength(1);

    await client.exec('reset role');
    const description = await client.query<{ description: string }>(
      'select description from ai_systems where id = $1',
      [registeredB.system.id],
    );
    expect(description.rows[0]?.description).toBe('B');
    await client.close();
  });

  it('lets the worker see every tenant and keeps the application role blind without context', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const orgA = await repos.organisations.create({ name: 'Organisation A', slug: 'worker-a' });
    const orgB = await repos.organisations.create({ name: 'Organisation B', slug: 'worker-b' });
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
    await repos.registerAiSystem({
      organisationId: orgA.id,
      environmentId: envA.id,
      name: 'Support A',
      description: 'A',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
    });
    await repos.registerAiSystem({
      organisationId: orgB.id,
      environmentId: envB.id,
      name: 'Support B',
      description: 'B',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
    });

    await client.exec('set role vhalcha_app');
    const hidden = await client.query('select id from ai_systems');
    expect(hidden.rows).toHaveLength(0);
    await client.exec('set role vhalcha_worker');
    const visible = await client.query('select id from ai_systems');
    expect(visible.rows).toHaveLength(2);
    await client.close();
  });
});
