import { describe, expect, it } from 'vitest';
import type { AppDatabase } from './client';
import { recordGuardEvent } from './guard';
import {
  addGuardIncidentNote,
  assignGuardIncident,
  attachGuardIncidentEvent,
  createGuardIncident,
  getGuardIncident,
  getGuardThreat,
  ingestGuardThreat,
  listGuardThreats,
  updateGuardIncidentStatus,
  updateGuardThreatStatus,
} from './guard-security';
import { createRepositories } from './repositories';
import { createTestDatabase } from './testing/harness';

async function organisation(name: string, slug: string) {
  const { db, client } = await createTestDatabase();
  const database = db as unknown as AppDatabase;
  const repos = createRepositories(database);
  const org = await repos.organisations.create({ name, slug });
  const env = await repos.environments.create({ organisationId: org.id, name: 'Production', type: 'production' });
  const user = await repos.users.create({
    organisationId: org.id,
    email: `owner@${slug}.test`,
    name: 'Owner',
    role: 'owner',
    passwordHash: null,
  });
  const system = await repos.registerAiSystem({
    organisationId: org.id,
    environmentId: env.id,
    name: 'Customer Support Agent',
    description: 'Support',
    type: 'agent',
    riskLevel: 'medium',
    monthlyBudgetUsd: 10,
    modelPattern: 'gpt-4.1-mini',
    requestsPerMinute: 60,
    generateKey: false,
    ownerUserId: user.id,
  });
  return { client, database, org, env, user, system: system.system };
}

describe('guard security center', () => {
  it('groups repeated live events and keeps a second system separate', async () => {
    const { client, database, org, env, system } = await organisation('Org Group', 'org-group');
    const other = await createRepositories(database).registerAiSystem({
      organisationId: org.id,
      environmentId: env.id,
      name: 'Finance Copilot',
      description: 'Finance',
      type: 'agent',
      riskLevel: 'high',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
      ownerUserId: (await createRepositories(database).users.create({
        organisationId: org.id,
        email: 'second@org-group.test',
        name: 'Second',
        role: 'security_admin',
        passwordHash: null,
      })).id,
    });
    const evidence = { classification: 'CUSTOMER_PII', outcome: 'redacted', redactionSummary: 'EMAIL=1', matchCount: 1, prompt: 'jane@example.com' };
    const first = await recordGuardEvent(database, {
      organisationId: org.id,
      aiSystemId: system.id,
      environmentId: env.id,
      eventType: 'sensitive_data',
      severity: 'medium',
      title: 'Sensitive data detected',
      description: 'contact jane@example.com',
      actionTaken: 'redact',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      policyName: 'Customer PII Protection',
      policyId: '00000000-0000-4000-8000-000000000010',
      dataCategory: 'pii',
      evidence,
    });
    await ingestGuardThreat(database, org.id, first.id);
    await recordGuardEvent(database, {
      organisationId: org.id,
      aiSystemId: system.id,
      environmentId: env.id,
      eventType: 'redacted_request',
      severity: 'medium',
      title: 'Request content redacted',
      actionTaken: 'redact',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      policyName: 'Customer PII Protection',
      policyId: '00000000-0000-4000-8000-000000000010',
      evidence,
    });
    await recordGuardEvent(database, {
      organisationId: org.id,
      aiSystemId: other.system.id,
      environmentId: env.id,
      eventType: 'sensitive_data',
      severity: 'medium',
      title: 'Sensitive data detected',
      actionTaken: 'monitor',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      policyId: '00000000-0000-4000-8000-000000000010',
      evidence: { ...evidence, outcome: 'would_enforce' },
    });
    await recordGuardEvent(database, {
      organisationId: org.id,
      aiSystemId: system.id,
      eventType: 'system_event',
      severity: 'info',
      title: 'Request inspected',
      actionTaken: 'monitor',
    });
    const listed = await listGuardThreats(database, org.id);
    expect(listed.total).toBe(2);
    const grouped = listed.rows.find((row) => row.aiSystemId === system.id);
    expect(grouped?.occurrenceCount).toBe(2);
    expect(grouped?.type).toBe('sensitive_data_exposure');
    expect(grouped?.severity).toBe('medium');
    expect(JSON.stringify(listed)).not.toContain('jane@example.com');
    const detail = await getGuardThreat(database, org.id, grouped?.id ?? '');
    expect(detail?.occurrences).toHaveLength(2);
    expect(JSON.stringify(detail)).not.toContain('jane@example.com');
    await client.close();
  });

  it('does not duplicate a threat when the same event is processed again', async () => {
    const { client, database, org, system } = await organisation('Org Retry', 'org-retry');
    const event = await recordGuardEvent(database, {
      organisationId: org.id,
      aiSystemId: system.id,
      eventType: 'blocked_request',
      severity: 'high',
      title: 'Request blocked',
      actionTaken: 'block',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      policyName: 'Approved Provider Policy',
      policyVersion: 2,
      decisionId: 'decision-1',
      evidence: { outcome: 'blocked', enforcementExecuted: 'true' },
    });
    await ingestGuardThreat(database, org.id, event.id);
    const threats = await listGuardThreats(database, org.id);
    expect(threats.total).toBe(1);
    expect(threats.rows[0]?.occurrenceCount).toBe(1);
    expect(threats.rows[0]?.outcome).toBe('blocked');
    expect(threats.rows[0]?.policyVersion).toBe(2);
    await client.close();
  });

  it('opens, assigns, notes and resolves an incident without copying raw evidence', async () => {
    const { client, database, org, user, system } = await organisation('Org Case', 'org-case');
    const investigator = await createRepositories(database).users.create({
      organisationId: org.id,
      email: 'investigator@org-case.test',
      name: 'Investigator',
      role: 'security_admin',
      passwordHash: null,
    });
    const event = await recordGuardEvent(database, {
      organisationId: org.id,
      aiSystemId: system.id,
      eventType: 'blocked_request',
      severity: 'high',
      title: 'Request blocked by Approved Provider Policy',
      actionTaken: 'block',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      policyId: '00000000-0000-4000-8000-000000000011',
      policyName: 'Approved Provider Policy',
      policyVersion: 4,
      decisionId: 'decision-block',
      requestId: undefined,
      evidence: { outcome: 'blocked', prompt: 'secret prompt jane@example.com' },
    });
    const threats = await listGuardThreats(database, org.id);
    const threatId = threats.rows[0]?.id ?? '';
    const incidentId = await createGuardIncident(database, org.id, {
      actorUserId: user.id,
      title: 'Sensitive customer data sent toward unapproved provider',
      description: 'Opened from the blocked request. jane@example.com',
      severity: 'high',
      threatId,
      eventId: event.id,
    });
    await assignGuardIncident(database, org.id, { incidentId, actorUserId: user.id, assigneeUserId: investigator.id });
    await addGuardIncidentNote(database, org.id, { incidentId, actorUserId: investigator.id, body: 'Checked the policy version.' });
    await updateGuardIncidentStatus(database, org.id, { incidentId, actorUserId: investigator.id, status: 'investigating' });
    await updateGuardIncidentStatus(database, org.id, { incidentId, actorUserId: investigator.id, status: 'contained' });
    await updateGuardIncidentStatus(database, org.id, {
      incidentId,
      actorUserId: investigator.id,
      status: 'resolved',
      resolution: 'The approved provider policy blocked the request. No provider call was made.',
      followUp: 'Review the policy.',
    });
    const detail = await getGuardIncident(database, org.id, incidentId);
    expect(detail?.incident.status).toBe('resolved');
    expect(detail?.ownerName).toBe('Investigator');
    expect(detail?.threats).toHaveLength(1);
    expect(detail?.events[0]?.decisionId).toBe('decision-block');
    expect(detail?.events[0]?.policyVersion).toBe(4);
    expect(detail?.notes).toHaveLength(1);
    expect(detail?.timeline.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['created', 'threat_attached', 'event_attached', 'owner_changed', 'note_added', 'status_changed', 'resolved']),
    );
    expect(JSON.stringify(detail)).not.toContain('jane@example.com');
    expect(JSON.stringify(detail)).not.toContain('secret prompt');
    await client.close();
  });

  it('stops organisation A from reading or mutating organisation B security records', async () => {
    const { client, database, org, env, user, system } = await organisation('Org A', 'org-sec-a');
    const repos = createRepositories(database);
    const orgB = await repos.organisations.create({ name: 'Org B', slug: 'org-sec-b' });
    const envB = await repos.environments.create({ organisationId: orgB.id, name: 'Production', type: 'production' });
    const userB = await repos.users.create({
      organisationId: orgB.id,
      email: 'owner@org-sec-b.test',
      name: 'Owner B',
      role: 'owner',
      passwordHash: null,
    });
    const systemB = await repos.registerAiSystem({
      organisationId: orgB.id,
      environmentId: envB.id,
      name: 'Agent B',
      description: 'Other',
      type: 'agent',
      riskLevel: 'medium',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
      ownerUserId: userB.id,
    });
    const event = await recordGuardEvent(database, {
      organisationId: orgB.id,
      aiSystemId: systemB.system.id,
      eventType: 'sensitive_data',
      severity: 'high',
      title: 'Sensitive data detected',
      actionTaken: 'block',
      evidence: { classification: 'PAYMENT_CARD', outcome: 'blocked' },
    });
    const secret = await listGuardThreats(database, orgB.id);
    const threatId = secret.rows[0]?.id ?? '';
    expect(await getGuardThreat(database, org.id, threatId)).toBeNull();
    expect(await listGuardThreats(database, org.id)).toEqual(expect.objectContaining({ total: 0 }));
    expect(
      await updateGuardThreatStatus(database, org.id, { threatId, actorUserId: user.id, status: 'dismissed', reason: 'no' }),
    ).toBeNull();
    await expect(
      createGuardIncident(database, org.id, {
        actorUserId: user.id,
        title: 'Cross tenant',
        severity: 'high',
        threatId,
        eventId: event.id,
      }),
    ).rejects.toThrow(/not found/i);
    const incidentId = await createGuardIncident(database, orgB.id, {
      actorUserId: userB.id,
      title: 'Org B incident',
      severity: 'high',
      threatId,
    });
    expect(await getGuardIncident(database, org.id, incidentId)).toBeNull();
    await expect(
      assignGuardIncident(database, orgB.id, { incidentId, actorUserId: userB.id, assigneeUserId: user.id }),
    ).rejects.toThrow(/not in this organisation/);
    expect(
      await attachGuardIncidentEvent(database, org.id, { incidentId, eventId: event.id, actorUserId: user.id }),
    ).toBeNull();
    expect(await addGuardIncidentNote(database, org.id, { incidentId, actorUserId: user.id, body: 'nope' })).toBeNull();
    expect(env.id).toBeTruthy();
    expect(system.id).toBeTruthy();
    await client.close();
  });
});
