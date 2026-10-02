import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, updateGuardSettings, type AppDatabase } from '@vhalcha/database';
import { activateGuardPolicy, createGuardPolicy, getGuardDecision, listGuardEvents, listGuardThreats } from '@vhalcha/database';
import { createTestDatabase } from '@vhalcha/database/testing';
import { normalizeOpenAiError, normalizeOpenAiUsage, type ModelProvider } from '@vhalcha/providers';
import { MemoryRedis } from '@vhalcha/redis';
import { createMetrics } from './metrics';
import { buildServer } from './server';
import type { GatewayDeps } from './pipeline';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function setup(options?: { guardEnabled?: boolean; protect?: boolean; failClosed?: boolean }) {
  const { db, client } = await createTestDatabase();
  const appDb = db as unknown as AppDatabase;
  const repos = createRepositories(appDb);
  const org = await repos.organisations.create({ name: 'Guard Org', slug: `guard-${crypto.randomUUID().slice(0, 8)}` });
  const other = await repos.organisations.create({ name: 'Other Org', slug: `other-${crypto.randomUUID().slice(0, 8)}` });
  const environment = await repos.environments.create({ organisationId: org.id, name: 'Production', type: 'production' });
  const owner = await repos.users.create({
    organisationId: org.id,
    email: `owner-${crypto.randomUUID().slice(0, 8)}@guard.test`,
    name: 'Owner',
    role: 'owner',
    passwordHash: null,
  });
  const registered = await repos.registerAiSystem({
    organisationId: org.id,
    environmentId: environment.id,
    name: 'Customer Service Agent',
    description: 'Test',
    type: 'assistant',
    riskLevel: 'medium',
    monthlyBudgetUsd: 25,
    modelPattern: 'gpt-4.1-mini',
    requestsPerMinute: 60,
    generateKey: true,
    ownerUserId: owner.id,
  });
  await repos.providerConnections.create({
    organisationId: org.id,
    environmentId: environment.id,
    provider: 'openai',
    name: 'OpenAI platform',
    credentialSource: 'platform_env',
  });
  if (options?.protect || options?.failClosed) {
    await updateGuardSettings(appDb, org.id, {
      actorUserId: owner.id,
      mode: 'protect',
      protectEnabled: true,
      enforcementFailureMode: options.failClosed ? 'fail_closed' : 'fail_open',
    });
  }
  const calls = { chat: 0, stream: 0 };
  const received: string[] = [];
  const provider: ModelProvider = {
    id: 'openai',
    async chatCompletion(request) {
      calls.chat += 1;
      received.push(request.messages.map((message) => String(message.content)).join('\n'));
      return {
        responseBody: {
          id: 'chatcmpl-test',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        providerLatencyMs: 4,
      };
    },
    async streamChatCompletion(request) {
      calls.stream += 1;
      received.push(request.messages.map((message) => String(message.content)).join('\n'));
      async function* chunks() {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
        yield new TextEncoder().encode('data: [DONE]\n\n');
      }
      return {
        status: 200,
        headers: {},
        chunks: chunks(),
        usage: () => ({ inputTokens: 4, outputTokens: 1, totalTokens: 5 }),
        timeToFirstTokenMs: () => 1,
        providerLatencyMs: () => 2,
      };
    },
    normalizeUsage: normalizeOpenAiUsage,
    normalizeError: normalizeOpenAiError,
  };
  const deps: GatewayDeps = {
    db: appDb,
    redis: new MemoryRedis(),
    provider,
    openAiApiKey: 'sk-test-not-real',
    logger: pino({ level: 'silent' }),
    metrics: createMetrics(),
    guardEnabled: options?.guardEnabled !== false,
    protectModeEnabled: Boolean(options?.protect || options?.failClosed),
  };
  const app = buildServer(deps);
  closers.push(async () => {
    await app.close();
    await client.close();
  });
  return { app, appDb, org, other, owner, registered, calls, received, environment };
}

async function post(app: ReturnType<typeof buildServer>, key: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

async function policy(
  db: AppDatabase,
  organisationId: string,
  actorUserId: string,
  input: Parameters<typeof createGuardPolicy>[1],
) {
  const created = await createGuardPolicy(db, input);
  await activateGuardPolicy(db, organisationId, created.policyId, actorUserId);
  return created;
}

describe('live guard enforcement', () => {
  it('records WOULD REDACT in monitor mode and sends the original email', async () => {
    const ctx = await setup();
    const key = ctx.registered.key?.rawKey ?? '';
    await policy(ctx.appDb, ctx.org.id, ctx.owner.id, {
      organisationId: ctx.org.id,
      actorUserId: ctx.owner.id,
      name: 'Customer PII Protection',
      category: 'data',
      mode: 'enforce',
      priority: 300,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' }] },
        actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
      },
    });
    const response = await post(ctx.app, key, { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Email jane@example.com' }] });
    expect(response.statusCode).toBe(200);
    expect(ctx.calls.chat).toBe(1);
    expect(ctx.received[0]).toContain('jane@example.com');
    expect(ctx.received[0]).not.toContain('[REDACTED:EMAIL]');
    const events = await listGuardEvents(ctx.appDb, ctx.org.id);
    expect(events.some((event) => event.eventType === 'redacted_request')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('jane@example.com');
  });

  it('redacts before the provider call when Protect is confirmed', async () => {
    const ctx = await setup({ protect: true });
    const key = ctx.registered.key?.rawKey ?? '';
    await policy(ctx.appDb, ctx.org.id, ctx.owner.id, {
      organisationId: ctx.org.id,
      actorUserId: ctx.owner.id,
      name: 'Customer PII Protection',
      category: 'data',
      mode: 'enforce',
      priority: 300,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' }] },
        actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
      },
    });
    const response = await post(ctx.app, key, { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Email jane@example.com' }] });
    expect(response.statusCode).toBe(200);
    expect(ctx.calls.chat).toBe(1);
    expect(ctx.received.join('\n')).toContain('[REDACTED:EMAIL]');
    expect(ctx.received.join('\n')).not.toContain('jane@example.com');
    const events = await listGuardEvents(ctx.appDb, ctx.org.id);
    expect(events.some((event) => event.eventType === 'redacted_request')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('jane@example.com');
    const threats = await listGuardThreats(ctx.appDb, ctx.org.id);
    expect(threats.rows.some((threat) => threat.type === 'sensitive_data_exposure' && threat.outcome === 'redacted')).toBe(true);
    expect(JSON.stringify(threats)).not.toContain('jane@example.com');
  });

  it('does not call the provider when Protect blocks', async () => {
    const ctx = await setup({ protect: true });
    const key = ctx.registered.key?.rawKey ?? '';
    const created = await policy(ctx.appDb, ctx.org.id, ctx.owner.id, {
      organisationId: ctx.org.id,
      actorUserId: ctx.owner.id,
      name: 'Unapproved Provider Protection',
      category: 'provider',
      mode: 'enforce',
      priority: 400,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'provider.id', operator: 'not_in', value: ['approved-provider'] }] },
        actions: [{ type: 'block' }],
      },
    });
    const response = await post(ctx.app, key, { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Hello' }] });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('guard_policy_blocked');
    expect(response.json().error.decision_id).toBeTruthy();
    expect(ctx.calls.chat).toBe(0);
    expect(ctx.calls.stream).toBe(0);
    const events = await listGuardEvents(ctx.appDb, ctx.org.id);
    expect(events.some((event) => event.eventType === 'blocked_request')).toBe(true);
    const decisionId = response.json().error.decision_id as string;
    const decision = await getGuardDecision(ctx.appDb, ctx.org.id, decisionId);
    expect(decision?.source).toBe('gateway');
    expect(decision?.matchedPolicies).toEqual(expect.arrayContaining([expect.objectContaining({ policyId: created.policyId, version: 1 })]));
    const threats = await listGuardThreats(ctx.appDb, ctx.org.id);
    expect(threats.rows.some((threat) => threat.type === 'policy_violation' && threat.outcome === 'blocked' && threat.decisionId === decisionId)).toBe(true);
  });

  it('keeps a monitor-mode policy non-destructive while the organisation is in Protect', async () => {
    const ctx = await setup({ protect: true });
    const key = ctx.registered.key?.rawKey ?? '';
    await policy(ctx.appDb, ctx.org.id, ctx.owner.id, {
      organisationId: ctx.org.id,
      actorUserId: ctx.owner.id,
      name: 'Monitor block',
      category: 'provider',
      mode: 'monitor',
      priority: 400,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'provider.id', operator: 'not_in', value: ['approved-provider'] }] },
        actions: [{ type: 'block' }],
      },
    });
    const response = await post(ctx.app, key, { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Hello there' }] });
    expect(response.statusCode).toBe(200);
    expect(ctx.calls.chat).toBe(1);
    expect(ctx.received[0]).toContain('Hello there');
  });

  it('continues on an unsupported approval action when failure mode is open and stops when it is closed', async () => {
    const open = await setup({ protect: true });
    await policy(open.appDb, open.org.id, open.owner.id, {
      organisationId: open.org.id,
      actorUserId: open.owner.id,
      name: 'Approval',
      category: 'tool',
      mode: 'enforce',
      priority: 500,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'require_approval', config: { approvalGroup: 'security-admin' } }],
      },
    });
    const openResponse = await post(open.app, open.registered.key?.rawKey ?? '', {
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Need a tool' }],
    });
    expect(openResponse.statusCode).toBe(200);
    expect(open.calls.chat).toBe(1);
    const openEvents = await listGuardEvents(open.appDb, open.org.id);
    expect(openEvents.some((event) => event.eventType === 'runtime_alert')).toBe(true);
    expect(JSON.stringify(openEvents)).not.toContain('approval was requested');

    const closed = await setup({ protect: true, failClosed: true });
    await policy(closed.appDb, closed.org.id, closed.owner.id, {
      organisationId: closed.org.id,
      actorUserId: closed.owner.id,
      name: 'Approval closed',
      category: 'tool',
      mode: 'enforce',
      priority: 500,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'require_approval', config: { approvalGroup: 'security-admin' } }],
      },
    });
    const closedResponse = await post(closed.app, closed.registered.key?.rawKey ?? '', {
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Need a tool' }],
    });
    expect(closedResponse.statusCode).toBe(403);
    expect(closedResponse.json().error.code).toBe('guard_enforcement_unavailable');
    expect(closed.calls.chat).toBe(0);
  });

  it('blocks and redacts streaming input without opening a blocked stream', async () => {
    const blocked = await setup({ protect: true });
    await policy(blocked.appDb, blocked.org.id, blocked.owner.id, {
      organisationId: blocked.org.id,
      actorUserId: blocked.owner.id,
      name: 'Stream block',
      category: 'provider',
      mode: 'enforce',
      priority: 400,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'provider.id', operator: 'not_in', value: ['approved-provider'] }] },
        actions: [{ type: 'block' }],
      },
    });
    const blockedResponse = await post(blocked.app, blocked.registered.key?.rawKey ?? '', {
      model: 'gpt-4.1-mini',
      stream: true,
      messages: [{ role: 'user', content: 'Stream me' }],
    });
    expect(blockedResponse.statusCode).toBe(403);
    expect(blocked.calls.stream).toBe(0);

    const redacted = await setup({ protect: true });
    await policy(redacted.appDb, redacted.org.id, redacted.owner.id, {
      organisationId: redacted.org.id,
      actorUserId: redacted.owner.id,
      name: 'Stream redact',
      category: 'data',
      mode: 'enforce',
      priority: 300,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' }] },
        actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
      },
    });
    const redactedResponse = await post(redacted.app, redacted.registered.key?.rawKey ?? '', {
      model: 'gpt-4.1-mini',
      stream: true,
      messages: [{ role: 'user', content: 'Email jane@example.com' }],
    });
    expect(redactedResponse.statusCode).toBe(200);
    expect(redacted.calls.stream).toBe(1);
    expect(redacted.received.join('\n')).toContain('[REDACTED:EMAIL]');
    expect(redacted.received.join('\n')).not.toContain('jane@example.com');
  });

  it('does not apply another organisation policy and skips Guard when disabled', async () => {
    const ctx = await setup();
    const otherOwner = await createRepositories(ctx.appDb).users.create({
      organisationId: ctx.other.id,
      email: `other-${crypto.randomUUID().slice(0, 8)}@guard.test`,
      name: 'Other',
      role: 'owner',
      passwordHash: null,
    });
    await policy(ctx.appDb, ctx.other.id, otherOwner.id, {
      organisationId: ctx.other.id,
      actorUserId: otherOwner.id,
      name: 'Foreign block',
      category: 'provider',
      mode: 'enforce',
      priority: 900,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'block' }],
      },
    });
    await updateGuardSettings(ctx.appDb, ctx.other.id, { actorUserId: otherOwner.id, mode: 'protect', protectEnabled: true });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '', {
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Hello from A' }],
      detectedDataTypes: [],
      guardMode: 'monitor',
    });
    expect(response.statusCode).toBe(400);
    const allowed = await post(ctx.app, ctx.registered.key?.rawKey ?? '', {
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Hello from A' }],
    });
    expect(allowed.statusCode).toBe(200);
    expect(ctx.calls.chat).toBe(1);

    const disabled = await setup({ guardEnabled: false, protect: true });
    await policy(disabled.appDb, disabled.org.id, disabled.owner.id, {
      organisationId: disabled.org.id,
      actorUserId: disabled.owner.id,
      name: 'Disabled block',
      category: 'provider',
      mode: 'enforce',
      priority: 400,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'provider.id', operator: 'not_in', value: ['approved-provider'] }] },
        actions: [{ type: 'block' }],
      },
    });
    const skipped = await post(disabled.app, disabled.registered.key?.rawKey ?? '', {
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Route as usual' }],
    });
    expect(skipped.statusCode).toBe(200);
    expect(disabled.calls.chat).toBe(1);
    expect(disabled.received[0]).toContain('Route as usual');
  });
});
