import { describe, expect, it } from 'vitest';
import type { AppDatabase } from './client';
import {
  getGuardEvent,
  getGuardSettings,
  listGuardAudit,
  listGuardEvents,
  markGuardEventExpected,
  recordGuardEvent,
  updateGuardSettings,
  upsertGuardProfile,
} from './guard';
import { createRepositories } from './repositories';
import { createTestDatabase } from './testing/harness';

describe('guard tenant isolation', () => {
  it('hides events, profiles and audit records from another organisation', async () => {
    const { db, client } = await createTestDatabase();
    const database = db as unknown as AppDatabase;
    const repos = createRepositories(database);
    const orgA = await repos.organisations.create({ name: 'Org A', slug: 'org-a' });
    const orgB = await repos.organisations.create({ name: 'Org B', slug: 'org-b' });
    const envA = await repos.environments.create({ organisationId: orgA.id, name: 'Development', type: 'development' });
    const envB = await repos.environments.create({ organisationId: orgB.id, name: 'Development', type: 'development' });
    const userA = await repos.users.create({
      organisationId: orgA.id,
      email: 'a@org-a.test',
      name: 'Owner A',
      role: 'owner',
      passwordHash: null,
    });
    const userB = await repos.users.create({
      organisationId: orgB.id,
      email: 'b@org-b.test',
      name: 'Owner B',
      role: 'owner',
      passwordHash: null,
    });
    const systemA = await repos.registerAiSystem({
      organisationId: orgA.id,
      environmentId: envA.id,
      name: 'Agent A',
      description: 'Test system',
      type: 'agent',
      riskLevel: 'medium',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
      ownerUserId: userA.id,
    });
    const systemB = await repos.registerAiSystem({
      organisationId: orgB.id,
      environmentId: envB.id,
      name: 'Agent B',
      description: 'Test system',
      type: 'agent',
      riskLevel: 'medium',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
      ownerUserId: userB.id,
    });
    const secretTitle = 'Customer card 4111111111111111';
    const stored = await recordGuardEvent(database, {
      organisationId: orgB.id,
      aiSystemId: systemB.system.id,
      eventType: 'sensitive_data',
      severity: 'high',
      title: secretTitle,
      description: 'authorization: Bearer super-secret-token',
      actionTaken: 'monitor',
      dataCategory: 'pii',
      evidence: { inspector: 'SensitiveDataInspector', matchCount: 1, prompt: secretTitle },
      metadata: { prompt: secretTitle, source: 'test' },
    });
    expect(stored.title).not.toContain('4111');
    expect(stored.description).not.toContain('super-secret-token');
    expect(stored.evidence).not.toHaveProperty('prompt');
    expect(JSON.stringify(stored.evidence)).not.toContain('4111');
    expect(await getGuardEvent(database, orgA.id, stored.id)).toBeNull();
    expect(await markGuardEventExpected(database, orgA.id, stored.id, userA.id)).toBeNull();
    expect((await listGuardEvents(database, orgA.id)).map((event) => event.id)).not.toContain(stored.id);
    await expect(
      upsertGuardProfile(database, orgA.id, {
        aiSystemId: systemB.system.id,
        actorUserId: userA.id,
        guardStatus: 'protected',
        runtime: 'vhalcha_gateway',
        dataAccess: [],
        sensitiveDataUnrestricted: false,
        overprivileged: false,
      }),
    ).rejects.toThrow(/not found/);
    const marked = await markGuardEventExpected(database, orgB.id, stored.id, userB.id);
    expect(marked?.status).toBe('expected');
    const audit = await listGuardAudit(database, orgB.id);
    expect(audit.some((event) => event.action === 'guard.event.marked_expected')).toBe(true);
    expect((await listGuardAudit(database, orgA.id)).some((event) => event.resourceId === stored.id)).toBe(false);
    expect(systemA.system.organisationId).toBe(orgA.id);
    await expect(
      upsertGuardProfile(database, orgA.id, {
        aiSystemId: systemA.system.id,
        actorUserId: userA.id,
        guardStatus: 'protected',
        runtime: 'vhalcha_gateway',
        dataAccess: [],
        sensitiveDataUnrestricted: false,
        overprivileged: false,
      }),
    ).rejects.toThrow(/Protected status is unavailable/);
    await client.close();
  });

  it('keeps existing organisations in monitor mode', async () => {
    const { db, client } = await createTestDatabase();
    const database = db as unknown as AppDatabase;
    const repos = createRepositories(database);
    const org = await repos.organisations.create({ name: 'Org C', slug: 'org-c' });
    const user = await repos.users.create({
      organisationId: org.id,
      email: 'c@org-c.test',
      name: 'Owner C',
      role: 'owner',
      passwordHash: null,
    });
    expect((await getGuardSettings(database, org.id)).mode).toBe('monitor');
    const saved = await updateGuardSettings(database, org.id, {
      actorUserId: user.id,
      retentionDays: 30,
      enforcementFailureMode: 'fail_closed',
      auditLoggingEnabled: true,
      guardEnabled: true,
    });
    expect(saved.mode).toBe('monitor');
    expect(saved.retentionDays).toBe(30);
    expect(saved.enforcementFailureMode).toBe('fail_closed');
    expect(saved.organisationLabel).toBe('standard');
    await client.close();
  });
});
