import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeRepository, createRepositories, indexKnowledgeVersion, type AppDatabase } from '@vhalcha/database';
import { createMockEmbeddingProvider, MemoryKnowledgeObjectStore, contentHash } from '@vhalcha/knowledge';
import { createTestDatabase } from '@vhalcha/database/testing';
import { normalizeOpenAiError, normalizeOpenAiUsage, type ModelProvider } from '@vhalcha/providers';
import { MemoryRedis, redisKeys } from '@vhalcha/redis';
import { createMetrics } from './metrics';
import { buildServer } from './server';

const payload = {
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Explain our return policy.' }],
};

async function setup(options?: {
  failProvider?: boolean | { current: boolean };
  requestsPerMinute?: number;
  holdProvider?: boolean;
  responseText?: string;
}) {
  const { db, client } = await createTestDatabase();
  const appDb = db as unknown as AppDatabase;
  const repos = createRepositories(appDb);
  const org = await repos.organisations.create({ name: 'Acme Corporation', slug: `acme-${crypto.randomUUID().slice(0, 8)}` });
  const environment = await repos.environments.create({
    organisationId: org.id,
    name: 'Development',
    type: 'development',
  });
  const registered = await repos.registerAiSystem({
    organisationId: org.id,
    environmentId: environment.id,
    name: 'Customer Support AI',
    description: 'Development test system',
    type: 'assistant',
    riskLevel: 'medium',
    monthlyBudgetUsd: 25,
    modelPattern: 'gpt-4.1-mini',
    requestsPerMinute: options?.requestsPerMinute ?? 60,
    generateKey: true,
  });
  await repos.providerConnections.create({
    organisationId: org.id,
    environmentId: environment.id,
    provider: 'openai',
    name: 'OpenAI platform',
    credentialSource: 'platform_env',
  });
  const calls = { chat: 0, stream: 0 };
  const received: string[] = [];
  let releaseProvider = () => {};
  const hold = options?.holdProvider
    ? new Promise<void>((resolve) => {
        releaseProvider = resolve;
      })
    : null;
  const responseText = options?.responseText ?? 'Return policy text';
  const provider: ModelProvider = {
    id: 'openai',
    async chatCompletion(request) {
      calls.chat += 1;
      received.push(request.messages.map((message) => message.content).join('\n'));
      if (hold) {
        await hold;
      }
      const failProvider = typeof options?.failProvider === 'object' ? options.failProvider.current : options?.failProvider;
      if (failProvider) {
        throw Object.assign(new Error('upstream'), {
          normalized: normalizeOpenAiError(new Error('upstream'), 500),
        });
      }
      return {
        responseBody: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        },
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        providerLatencyMs: 12,
      };
    },
    async streamChatCompletion() {
      calls.stream += 1;
      const encoder = new TextEncoder();
      async function* chunks() {
        yield encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        yield encoder.encode('data: [DONE]\n\n');
      }
      return {
        status: 200,
        headers: {},
        chunks: chunks(),
        usage: () => ({ inputTokens: 4, outputTokens: 1, totalTokens: 5 }),
        timeToFirstTokenMs: () => 3,
        providerLatencyMs: () => 8,
      };
    },
    normalizeUsage: normalizeOpenAiUsage,
    normalizeError: normalizeOpenAiError,
  };
  const redis = new MemoryRedis();
  const metrics = createMetrics();
  const app = buildServer({
    db: appDb,
    redis,
    provider,
    openAiApiKey: 'sk-test-not-real',
    logger: pino({ level: 'silent' }),
    metrics,
    embedder: createMockEmbeddingProvider(),
  });
  return { app, repos, org, environment, registered, calls, received, client, appDb, redis, metrics, releaseProvider };
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) {
    await closers.pop()?.();
  }
});

async function post(
  app: Awaited<ReturnType<typeof setup>>['app'],
  key: string,
  body: unknown = payload,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...headers,
    },
    payload: JSON.stringify(body),
  });
}

describe('gateway control plane', () => {
  it('accepts a virtual key, calls the provider, and records usage and audit', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const rawKey = ctx.registered.key?.rawKey ?? '';
    const response = await post(ctx.app, rawKey);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'chatcmpl-test' });
    expect(response.body).not.toContain('sk-test');
    expect(ctx.calls.chat).toBe(1);
    const usage = await ctx.repos.usage.list(ctx.org.id);
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]?.costUsd)).toBeCloseTo(0.0012, 6);
    const audits = await ctx.repos.audit.list(ctx.org.id);
    expect(audits.some((event) => event.action === 'gateway.request.completed')).toBe(true);
    const requests = await ctx.repos.requests.list(ctx.org.id, new Date('2020-01-01'), new Date('2100-01-01'));
    expect(requests[0]?.status).toBe('succeeded');
    expect(requests[0]?.model).toBe('gpt-4.1-mini');
  });

  it('rejects an invalid key without calling the provider', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const response = await post(ctx.app, `vh_test_${'a'.repeat(43)}`);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'invalid_api_key', message: 'The provided Vhalcha API key is invalid.' },
    });
    expect(ctx.calls.chat).toBe(0);
  });

  it('rejects a revoked key', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    await ctx.repos.apiKeys.revoke(ctx.org.id, ctx.registered.key?.record.id ?? '');
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('api_key_revoked');
    expect(ctx.calls.chat).toBe(0);
  });

  it('rejects a disabled AI system', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    await ctx.repos.aiSystems.setStatus(ctx.org.id, ctx.registered.system.id, 'disabled');
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('system_disabled');
    expect(ctx.calls.chat).toBe(0);
  });

  it('blocks a model that is outside the access rule', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '', {
      ...payload,
      model: 'gpt-4o',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('model_not_allowed');
    expect(ctx.calls.chat).toBe(0);
    const requests = await ctx.repos.requests.list(ctx.org.id, new Date('2020-01-01'), new Date('2100-01-01'));
    expect(requests[0]?.status).toBe('blocked');
  });

  it('allows spend below the warning threshold', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const prior = await ctx.repos.requests.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.registered.key?.record.id ?? '',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'succeeded',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await ctx.repos.usage.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      requestId: prior.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 1,
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(200);
    const requestId = response.headers['x-vhalcha-request-id'];
    const stored = await ctx.repos.requests.findById(ctx.org.id, String(requestId));
    expect(stored?.policyResult).toBe('allowed');
  });

  it('warns at the budget threshold and still calls the provider', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const prior = await ctx.repos.requests.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.registered.key?.record.id ?? '',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'succeeded',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await ctx.repos.usage.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      requestId: prior.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 20,
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(200);
    expect(ctx.calls.chat).toBe(1);
    const policies = await ctx.repos.policyEvents.list(ctx.org.id);
    expect(policies.some((event) => event.result === 'warning' && event.policyType === 'budget')).toBe(true);
  });

  it('blocks at the hard budget and does not call the provider', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const prior = await ctx.repos.requests.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.registered.key?.record.id ?? '',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'succeeded',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await ctx.repos.usage.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      requestId: prior.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 25,
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe('budget_exceeded');
    expect(ctx.calls.chat).toBe(0);
    expect(ctx.metrics.snapshot().counters.budget_blocks).toBe(1);
    const audits = await ctx.repos.audit.list(ctx.org.id);
    expect(audits.some((event) => event.result === 'blocked' && event.action === 'gateway.request.blocked')).toBe(
      true,
    );
  });

  it('enforces the AI system rate limit', async () => {
    const ctx = await setup({ requestsPerMinute: 1 });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const key = ctx.registered.key?.rawKey ?? '';
    expect((await post(ctx.app, key)).statusCode).toBe(200);
    const limited = await post(ctx.app, key);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limit_exceeded');
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(ctx.calls.chat).toBe(1);
  });

  it('records provider failure without leaking upstream details', async () => {
    const ctx = await setup({ failProvider: true });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('provider_unavailable');
    expect(response.body).not.toContain('upstream');
    const requests = await ctx.repos.requests.list(ctx.org.id, new Date('2020-01-01'), new Date('2100-01-01'));
    expect(requests.some((row) => row.status === 'failed')).toBe(true);
    const reservations = await ctx.repos.budgetReservations.list(ctx.org.id);
    expect(reservations.every((row) => row.status === 'released')).toBe(true);
  });

  it('keeps another organisation request invisible', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const other = await ctx.repos.organisations.create({ name: 'Other', slug: `other-${crypto.randomUUID().slice(0, 8)}` });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    const requestId = String(response.headers['x-vhalcha-request-id']);
    expect(await ctx.repos.requests.findById(other.id, requestId)).toBeNull();
    expect(await ctx.repos.usage.list(other.id)).toEqual([]);
    expect((await ctx.repos.audit.list(other.id)).some((event) => event.requestId === requestId)).toBe(false);
  });

  it('fails closed when redis cannot rate limit', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    ctx.redis.incr = async () => {
      throw new Error('redis down');
    };
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('rate_limiter_unavailable');
    expect(ctx.calls.chat).toBe(0);
  });

  it('does not call the provider when postgres enforcement is unavailable', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const broken = new Proxy(ctx.appDb, {
      get(target, property, receiver) {
        if (property === 'select') {
          return () => {
            throw new Error('ECONNREFUSED password=super-secret');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as AppDatabase;
    const app = buildServer({
      db: broken,
      redis: new MemoryRedis(),
      provider: {
        id: 'openai',
        chatCompletion: async () => {
          throw new Error('should not be called');
        },
        streamChatCompletion: async () => {
          throw new Error('should not be called');
        },
        normalizeUsage: normalizeOpenAiUsage,
        normalizeError: normalizeOpenAiError,
      },
      openAiApiKey: 'sk-test',
      logger: pino({ level: 'silent' }),
      metrics: createMetrics(),
    });
    closers.push(async () => {
      await app.close();
    });
    const response = await post(app, ctx.registered.key?.rawKey ?? '');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('control_plane_unavailable');
    expect(response.body).not.toContain('super-secret');
    expect(response.body).not.toContain('ECONNREFUSED');
  });

  it('streams provider output and finalises usage', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '', { ...payload, stream: true });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Hello');
    expect(response.body).not.toContain('Explain our return policy');
    const usage = await ctx.repos.usage.list(ctx.org.id);
    expect(usage[0]?.totalTokens).toBe(5);
  });

  it('replays a non-streaming idempotent request without a second provider call', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const headers = { 'idempotency-key': 'retry-1' };
    const key = ctx.registered.key?.rawKey ?? '';
    const first = await post(ctx.app, key, payload, headers);
    const second = await post(ctx.app, key, payload, headers);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('idempotent_request_already_completed');
    expect(second.json().error.request_id).toBe(String(first.headers['x-vhalcha-request-id']));
    expect(ctx.calls.chat).toBe(1);
    expect(await ctx.repos.usage.list(ctx.org.id)).toHaveLength(1);
    const stored = await ctx.redis.get(
      redisKeys.idempotency(ctx.org.id, ctx.registered.key?.record.id ?? '', 'retry-1'),
    );
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('Return policy text');
    expect(stored).not.toContain('choices');
  });

  it('retries a retryable provider failure with the same idempotency key and fingerprint', async () => {
    const failProvider = { current: true };
    const ctx = await setup({ failProvider });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const headers = { 'idempotency-key': 'retryable-1' };
    const key = ctx.registered.key?.rawKey ?? '';
    const failed = await post(ctx.app, key, payload, headers);
    expect(failed.statusCode).toBe(503);
    const stored = await ctx.redis.get(redisKeys.idempotency(ctx.org.id, ctx.registered.key?.record.id ?? '', 'retryable-1'));
    expect(stored).toContain('retryable_failed');
    failProvider.current = false;
    const retried = await post(ctx.app, key, payload, headers);
    expect(retried.statusCode).toBe(200);
    expect(ctx.calls.chat).toBe(2);
    expect(await ctx.repos.usage.list(ctx.org.id)).toHaveLength(1);
  });

  it('reports health and readiness without infrastructure secrets', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    const ready = await ctx.app.inject({ method: 'GET', url: '/ready' });
    expect(health.json()).toEqual({ status: 'ok' });
    expect(ready.json()).toEqual({ status: 'ready' });
    expect(ready.body).not.toContain('postgres');
  });

  it('lets only one of two concurrent reservations spend the remaining budget', async () => {
    const ctx = await setup({ holdProvider: true });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    await ctx.repos.budgets.update(ctx.org.id, ctx.registered.budget.id, { amountUsd: 1 });
    const prior = await ctx.repos.requests.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      environmentId: ctx.environment.id,
      virtualApiKeyId: ctx.registered.key?.record.id ?? '',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'succeeded',
      policyResult: 'allowed',
      startedAt: new Date(),
    });
    await ctx.repos.usage.create({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      requestId: prior.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0.9,
    });
    const key = ctx.registered.key?.rawKey ?? '';
    const body = { ...payload, max_tokens: 49999 };
    let rejected = false;
    const tasks = [0, 1].map(async () => {
      const response = await post(ctx.app, key, body);
      if (response.statusCode === 402) {
        rejected = true;
      }
      return response;
    });
    const deadline = Date.now() + 8000;
    while ((!rejected || ctx.calls.chat < 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(ctx.calls.chat).toBe(1);
    expect(rejected).toBe(true);
    ctx.releaseProvider();
    const responses = await Promise.all(tasks);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 402]);
    expect(ctx.calls.chat).toBe(1);
  });

  it('reconciles a reservation down to actual usage and warns when actual exceeds the hold', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '', { ...payload, max_tokens: 1 });
    expect(response.statusCode).toBe(200);
    const reservations = await ctx.repos.budgetReservations.list(ctx.org.id);
    expect(reservations[0]?.status).toBe('finalized');
    expect(Number(reservations[0]?.actualUsd)).toBeGreaterThan(Number(reservations[0]?.reservedUsd));
    const policies = await ctx.repos.policyEvents.list(ctx.org.id);
    expect(policies.some((event) => event.policyName === 'Reservation reconciliation')).toBe(true);
    const usage = await ctx.repos.usage.list(ctx.org.id);
    expect(Number(usage[0]?.costUsd)).toBeCloseTo(0.0012, 6);
  });

  it('rejects a second idempotency key when the request fingerprint differs', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const headers = { 'idempotency-key': 'same-key' };
    const key = ctx.registered.key?.rawKey ?? '';
    expect((await post(ctx.app, key, payload, headers)).statusCode).toBe(200);
    const conflict = await post(ctx.app, key, { ...payload, temperature: 0.2 }, headers);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    expect(ctx.calls.chat).toBe(1);
  });

  it('does not store a distinctive completion in redis or control-plane rows', async () => {
    const secret = 'VERY_SECRET_TEST_RESPONSE_83921';
    const ctx = await setup({ responseText: secret });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '', payload, { 'idempotency-key': 'privacy-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(secret);
    const stored = await ctx.redis.get(
      redisKeys.idempotency(ctx.org.id, ctx.registered.key?.record.id ?? '', 'privacy-1'),
    );
    const requestId = String(response.headers['x-vhalcha-request-id']);
    const request = await ctx.repos.requests.findById(ctx.org.id, requestId);
    const usage = await ctx.repos.usage.list(ctx.org.id);
    const audits = await ctx.repos.audit.list(ctx.org.id);
    const policies = await ctx.repos.policyEvents.list(ctx.org.id);
    const persisted = JSON.stringify({ stored, request, usage, audits, policies });
    expect(persisted).not.toContain(secret);
  });

  it('marks the request provider_started before the provider returns', async () => {
    const ctx = await setup({ holdProvider: true });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const pending = post(ctx.app, ctx.registered.key?.rawKey ?? '');
    const deadline = Date.now() + 8000;
    while (ctx.calls.chat < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const rows = await ctx.repos.requests.list(ctx.org.id, new Date('2020-01-01'), new Date('2100-01-01'));
    expect(rows.some((row) => row.status === 'provider_started')).toBe(true);
    ctx.releaseProvider();
    expect((await pending).statusCode).toBe(200);
  });

  it('serves attention and blocks offline', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const key = ctx.registered.key?.rawKey ?? '';
    await ctx.repos.aiSystems.setStatus(ctx.org.id, ctx.registered.system.id, 'attention');
    expect((await post(ctx.app, key)).statusCode).toBe(200);
    await ctx.repos.aiSystems.setStatus(ctx.org.id, ctx.registered.system.id, 'offline');
    const blocked = await post(ctx.app, key);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('system_disabled');
  });

  it('grounds an enabled system in approved knowledge and drops invented citations', async () => {
    const ctx = await setup({ responseText: 'The returns window is 30 days [S1] [S99].' });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const knowledge = createKnowledgeRepository(ctx.appDb);
    const space = await knowledge.createSpace({ organisationId: ctx.org.id, name: 'Support' });
    const source = await knowledge.createSource({
      organisationId: ctx.org.id,
      knowledgeSpaceId: space.id,
      name: 'Returns',
      sourceType: 'manual_text',
    });
    const text = 'The returns policy allows refunds within 30 days.';
    const created = await knowledge.createPendingDocument({
      organisationId: ctx.org.id,
      knowledgeSpaceId: space.id,
      knowledgeSourceId: source.id,
      title: 'Returns Policy',
      documentType: 'text',
      mimeType: 'text/plain',
      contentHash: contentHash(text),
      extractedText: text,
    });
    await indexKnowledgeVersion(ctx.appDb, {
      organisationId: ctx.org.id,
      documentVersionId: created.versionId,
      embedder: createMockEmbeddingProvider(),
      store: new MemoryKnowledgeObjectStore(),
    });
    await knowledge.grantAccess({
      organisationId: ctx.org.id,
      aiSystemId: ctx.registered.system.id,
      knowledgeSpaceId: space.id,
    });
    await knowledge.updateSystemKnowledge(ctx.org.id, ctx.registered.system.id, { knowledgeEnabled: true });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '', {
      ...payload,
      messages: [{ role: 'user', content: 'What is the returns policy?' }],
    });
    expect(response.statusCode).toBe(200);
    expect(ctx.received.at(-1)).toContain('VHALCHA APPROVED KNOWLEDGE');
    expect(ctx.received.at(-1)).toContain('reference information');
    const body = response.json() as { vhalcha?: { knowledge?: { citations?: Array<{ citation_id: string }> } } };
    const citationIds = body.vhalcha?.knowledge?.citations?.map((citation) => citation.citation_id) ?? [];
    expect(citationIds).toContain('S1');
    expect(citationIds).not.toContain('S99');
    const traces = await knowledge.listRetrievalForRequest(ctx.org.id, String(response.headers['x-vhalcha-request-id']));
    expect(traces.length).toBeGreaterThan(0);
    const reservations = await ctx.repos.budgetReservations.list(ctx.org.id);
    expect(reservations.some((row) => row.status === 'finalized')).toBe(true);
  });

  it('does not call the provider when strict grounding has no approved evidence', async () => {
    const ctx = await setup();
    closers.push(async () => {
      await ctx.app.close();
      await ctx.client.close();
    });
    const knowledge = createKnowledgeRepository(ctx.appDb);
    await knowledge.updateSystemKnowledge(ctx.org.id, ctx.registered.system.id, {
      knowledgeEnabled: true,
      strictGrounding: true,
    });
    const response = await post(ctx.app, ctx.registered.key?.rawKey ?? '', {
      ...payload,
      messages: [{ role: 'user', content: 'What is the secret discount code?' }],
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("couldn't verify that");
    expect(ctx.calls.chat).toBe(0);
  });
});
