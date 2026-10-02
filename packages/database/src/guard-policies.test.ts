import { describe, expect, it } from 'vitest';
import { listGuardEvents } from './guard';
import {
  activateGuardPolicy,
  createGuardPolicy,
  deleteGuardPolicy,
  disableGuardPolicy,
  evaluateGuardPolicies,
  getGuardDecision,
  getGuardPolicy,
  listGuardPolicies,
  updateGuardPolicy,
} from './guard-policies';
import type { AppDatabase } from './client';
import { createRepositories } from './repositories';
import { createTestDatabase } from './testing/harness';
import type { GuardPolicyDocument } from '@vhalcha/guard';

const secret = 'sk-live-abcdefghijklmnop';

function document(systemId: string, provider = 'approved-provider'): GuardPolicyDocument {
  return {
    scope: { systemIds: [systemId], environments: ['production'] },
    conditions: {
      logic: 'all',
      conditions: [
        { field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' },
        { field: 'provider.id', operator: 'not_in', value: [provider] },
      ],
    },
    actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
  };
}

describe('guard policies', () => {
  it('versions decisions inside one organisation and hides them from another', async () => {
    const { db, client } = await createTestDatabase();
    const database = db as unknown as AppDatabase;
    const repos = createRepositories(database);
    const orgA = await repos.organisations.create({ name: 'Policy A', slug: 'policy-a' });
    const orgB = await repos.organisations.create({ name: 'Policy B', slug: 'policy-b' });
    const envA = await repos.environments.create({ organisationId: orgA.id, name: 'Production', type: 'production' });
    const envB = await repos.environments.create({ organisationId: orgB.id, name: 'Production', type: 'production' });
    const userA = await repos.users.create({
      organisationId: orgA.id,
      email: 'owner@policy-a.test',
      name: 'Owner A',
      role: 'owner',
      passwordHash: null,
    });
    const userB = await repos.users.create({
      organisationId: orgB.id,
      email: 'owner@policy-b.test',
      name: 'Owner B',
      role: 'owner',
      passwordHash: null,
    });
    const systemA = await repos.registerAiSystem({
      organisationId: orgA.id,
      environmentId: envA.id,
      name: 'Customer Service Agent',
      description: 'Test',
      type: 'agent',
      riskLevel: 'medium',
      monthlyBudgetUsd: 10,
      modelPattern: 'example-model',
      requestsPerMinute: 60,
      generateKey: false,
      ownerUserId: userA.id,
    });
    const systemB = await repos.registerAiSystem({
      organisationId: orgB.id,
      environmentId: envB.id,
      name: 'Other Agent',
      description: 'Test',
      type: 'agent',
      riskLevel: 'medium',
      monthlyBudgetUsd: 10,
      modelPattern: 'example-model',
      requestsPerMinute: 60,
      generateKey: false,
      ownerUserId: userB.id,
    });

    const created = await createGuardPolicy(database, {
      organisationId: orgA.id,
      actorUserId: userA.id,
      name: 'Customer PII Protection',
      description: 'Control customer data.',
      category: 'data',
      mode: 'enforce',
      priority: 300,
      document: document(systemA.system.id),
    });
    expect(created.version).toBe(1);
    expect(await getGuardPolicy(database, orgB.id, created.policyId)).toBeNull();
    await expect(
      activateGuardPolicy(database, orgB.id, created.policyId, userB.id),
    ).rejects.toThrow(/not found/);
    await expect(
      updateGuardPolicy(database, {
        organisationId: orgB.id,
        actorUserId: userB.id,
        policyId: created.policyId,
        name: 'Stolen',
        category: 'data',
        mode: 'enforce',
        priority: 300,
        document: document(systemB.system.id),
      }),
    ).rejects.toThrow(/not found/);

    await activateGuardPolicy(database, orgA.id, created.policyId, userA.id);
    const active = await getGuardPolicy(database, orgA.id, created.policyId);
    expect(active?.policy.status).toBe('active');
    expect(active?.policy.currentVersion).toBe(1);

    const decision = await evaluateGuardPolicies(database, {
      organisationId: orgA.id,
      source: 'tester',
      context: {
        organizationId: orgA.id,
        system: { id: systemA.system.id },
        environment: 'production',
        provider: { id: 'unapproved-provider', name: secret },
        request: { detectedDataTypes: ['CUSTOMER_PII'], detectedSecrets: [secret] },
      },
    });
    expect(decision.decision).toBe('monitor');
    expect(decision.wouldEnforce?.action).toBe('redact');
    expect(decision.enforcementExecuted).toBe(false);
    expect(decision.matchedPolicies[0]?.version).toBe(1);
    expect(decision.reasons.join(' ')).toContain('Customer PII Protection v1');
    expect(JSON.stringify(decision.reasons)).not.toContain(secret);
    const stored = await getGuardDecision(database, orgA.id, decision.id);
    expect(stored?.source).toBe('tester');
    expect(JSON.stringify(stored?.contextSummary)).not.toContain(secret);
    expect(JSON.stringify(stored?.reasons)).not.toContain(secret);
    expect(await getGuardDecision(database, orgB.id, decision.id)).toBeNull();
    expect(await listGuardEvents(database, orgA.id)).toHaveLength(0);

    const edited = await updateGuardPolicy(database, {
      organisationId: orgA.id,
      actorUserId: userA.id,
      policyId: created.policyId,
      name: 'Customer PII Protection',
      category: 'data',
      mode: 'enforce',
      priority: 300,
      document: document(systemA.system.id, 'another-provider'),
    });
    expect(edited.version).toBe(2);
    expect(edited.previousVersion).toBe(1);
    const after = await getGuardPolicy(database, orgA.id, created.policyId);
    expect(after?.versions.map((version) => version.version).sort()).toEqual([1, 2]);
    const historical = after?.versions.find((version) => version.version === 1);
    expect(JSON.stringify(historical?.actions)).toContain('redact');
    expect(JSON.stringify(historical?.conditions)).toContain('approved-provider');
    expect(decision.matchedPolicies[0]?.policyVersionId).toBe(after?.versions.find((version) => version.version === 1)?.id);

    await expect(deleteGuardPolicy(database, orgA.id, created.policyId, userA.id)).rejects.toThrow(/Disable/);
    await disableGuardPolicy(database, orgA.id, created.policyId, userA.id);
    expect((await getGuardPolicy(database, orgA.id, created.policyId))?.policy.status).toBe('disabled');
    const listed = await listGuardPolicies(database, orgB.id);
    expect(listed).toHaveLength(0);

    const draft = await createGuardPolicy(database, {
      organisationId: orgA.id,
      actorUserId: userA.id,
      name: 'Unused draft',
      category: 'security',
      mode: 'monitor',
      priority: 100,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'monitor' }],
      },
    });
    await deleteGuardPolicy(database, orgA.id, draft.policyId, userA.id);
    expect(await getGuardPolicy(database, orgA.id, draft.policyId)).toBeNull();
    const audits = after ? (await getGuardPolicy(database, orgA.id, created.policyId))?.audits.map((event) => event.action) : [];
    expect(audits).toEqual(expect.arrayContaining(['guard.policy.created', 'guard.policy.activated', 'guard.policy.updated', 'guard.policy.disabled']));
    await client.close();
  });
});
