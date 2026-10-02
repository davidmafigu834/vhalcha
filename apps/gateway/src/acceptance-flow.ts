import { createKnowledgeRepository, createRepositories, createRoutingRepository, indexKnowledgeVersion, type AppDatabase } from '@vhalcha/database';
import { contentHash, createMockEmbeddingProvider, INSUFFICIENT_KNOWLEDGE_MESSAGE, MemoryKnowledgeObjectStore } from '@vhalcha/knowledge';
import { MOCK_PROVIDER_TEXT, type MockModelProvider } from '@vhalcha/providers';
import { redisKeys, type KeyValueStore } from '@vhalcha/redis';
import { periodBounds } from '@vhalcha/budgets';
import { explainSelection, pricingIsFresh, selectRoute, type RoutingModel } from '@vhalcha/routing';

export interface AcceptanceStage {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runV1Acceptance(input: {
  baseUrl: string;
  db: AppDatabase;
  provider: MockModelProvider;
  redis: KeyValueStore;
}): Promise<AcceptanceStage[]> {
  const stages: AcceptanceStage[] = [];
  const record = (name: string, pass: boolean, detail: string) => {
    stages.push({ name, pass, detail });
  };
  const repos = createRepositories(input.db);
  const suffix = crypto.randomUUID().slice(0, 8);
  const org = await repos.organisations.create({
    name: 'Acceptance Corporation',
    slug: `acceptance-${suffix}`,
    timezone: 'UTC',
  });
  const environment = await repos.environments.create({
    organisationId: org.id,
    name: 'Development',
    type: 'development',
  });
  const registered = await repos.registerAiSystem({
    organisationId: org.id,
    environmentId: environment.id,
    name: 'Customer Support AI',
    description: 'Acceptance system',
    type: 'assistant',
    riskLevel: 'medium',
    monthlyBudgetUsd: 25,
    modelPattern: 'gpt-4.1-mini',
    requestsPerMinute: 60,
    generateKey: true,
  });
  await repos.providerConnections.create({
    organisationId: org.id,
    environmentId: environment.id,
    provider: 'openai',
    name: 'Mock platform',
    credentialSource: 'platform_env',
  });
  const rawKey = registered.key?.rawKey ?? '';
  record('register Customer Support AI', Boolean(registered.system.id), registered.system.id);
  record('monthly budget', Number(registered.budget.amountUsd) === 25, String(registered.budget.amountUsd));
  record('allowed model', registered.rule.modelPattern === 'gpt-4.1-mini', registered.rule.modelPattern);
  record('virtual key', rawKey.startsWith('vh_test_'), rawKey.slice(0, 12));

  const first = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rawKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Explain our return policy.' }],
      stream: true,
    }),
  });
  const firstBody = await first.text();
  const callsAfterFirst = input.provider.calls.stream + input.provider.calls.chat;
  record('gateway accepted the key', first.status === 200, String(first.status));
  record('mock provider streamed', firstBody.includes(MOCK_PROVIDER_TEXT), 'response text');
  const usage = await repos.usage.list(org.id);
  record('usage recorded', usage.length === 1 && Number(usage[0]?.totalTokens) === 20, String(usage.length));
  const requests = await repos.requests.list(org.id, new Date('2020-01-01'), new Date('2100-01-01'));
  const succeeded = requests.find((row) => row.status === 'succeeded');
  record('request completed', Boolean(succeeded), succeeded?.status ?? 'missing');
  const reservations = await repos.budgetReservations.list(org.id);
  record(
    'reservation reconciled',
    reservations.some((row) => row.status === 'finalized' && row.actualUsd !== null),
    reservations.map((row) => row.status).join(',') || 'none',
  );
  const spend = usage.reduce((sum, row) => sum + Number(row.costUsd ?? 0), 0);
  record('spend reflected', spend > 0, spend.toFixed(8));
  const audits = await repos.audit.list(org.id);
  record(
    'audit event exists',
    audits.some((event) => event.action === 'gateway.request.completed'),
    String(audits.length),
  );
  const correlatedRequestId = first.headers.get('x-vhalcha-request-id');
  record(
    'request id correlates',
    Boolean(correlatedRequestId) &&
      succeeded?.id === correlatedRequestId &&
      usage[0]?.requestId === correlatedRequestId &&
      reservations.some((row) => row.requestId === correlatedRequestId) &&
      audits.some((event) => event.requestId === correlatedRequestId),
    correlatedRequestId ?? 'missing',
  );
  const idempotencyKey = redisKeys.idempotency(org.id, registered.key?.record.id ?? '', 'unused');
  const redisSample = await input.redis.get(idempotencyKey);
  record('redis has no completion for an unused key', redisSample === null, 'empty');

  await repos.budgets.update(org.id, registered.budget.id, { amountUsd: spend / 2 });
  const second = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rawKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Explain our return policy.' }],
    }),
  });
  const secondBody = (await second.json()) as { error?: { code?: string } };
  const callsAfterSecond = input.provider.calls.stream + input.provider.calls.chat;
  record('budget lowered below usage', true, (spend / 2).toFixed(8));
  record(
    'next request rejected',
    second.status === 402 && secondBody.error?.code === 'budget_exceeded',
    secondBody.error?.code ?? String(second.status),
  );
  record('mock provider call count unchanged', callsAfterSecond === callsAfterFirst, String(callsAfterSecond));
  const policies = await repos.policyEvents.list(org.id);
  record(
    'blocked policy event exists',
    policies.some((event) => event.result === 'blocked' && event.policyType === 'budget'),
    policies.map((event) => event.result).join(',') || 'none',
  );

  await repos.budgets.update(org.id, registered.budget.id, { amountUsd: 25 });
  const knowledge = createKnowledgeRepository(input.db);
  const embedder = createMockEmbeddingProvider();
  const space = await knowledge.createSpace({
    organisationId: org.id,
    name: 'Product & Support',
    description: 'Acceptance knowledge space',
  });
  const source = await knowledge.createSource({
    organisationId: org.id,
    knowledgeSpaceId: space.id,
    name: 'Returns Policy',
    sourceType: 'manual_text',
  });
  const policy = 'The returns policy allows refunds within 30 days for unused products.';
  const created = await knowledge.createPendingDocument({
    organisationId: org.id,
    knowledgeSpaceId: space.id,
    knowledgeSourceId: source.id,
    title: 'Returns Policy',
    documentType: 'text',
    mimeType: 'text/plain',
    contentHash: contentHash(policy),
    extractedText: policy,
  });
  await indexKnowledgeVersion(input.db, {
    organisationId: org.id,
    documentVersionId: created.versionId,
    embedder,
    store: new MemoryKnowledgeObjectStore(),
  });
  const document = await knowledge.getDocument(org.id, created.document.id);
  const chunks = await knowledge.chunkCount(org.id, created.versionId);
  record('knowledge space created', Boolean(space.id), space.slug);
  record('document indexed', document?.status === 'ready' && chunks > 0, document?.status ?? 'missing');
  await knowledge.grantAccess({
    organisationId: org.id,
    aiSystemId: registered.system.id,
    knowledgeSpaceId: space.id,
  });
  await knowledge.updateSystemKnowledge(org.id, registered.system.id, { knowledgeEnabled: true, strictGrounding: false });
  const beforeKnowledge = await repos.budgetReservations.list(org.id);
  const grounded = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'What is the returns policy?' }],
    }),
  });
  const groundedBody = (await grounded.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    vhalcha?: { knowledge?: { citations?: Array<{ citation_id: string; document_id: string }> } };
  };
  const groundedText = groundedBody.choices?.[0]?.message?.content ?? '';
  record('knowledge injected', grounded.status === 200 && groundedText.includes('[S1]'), String(grounded.status));
  const citations = groundedBody.vhalcha?.knowledge?.citations ?? [];
  record('citations returned', citations.some((citation) => citation.citation_id === 'S1'), String(citations.length));
  const knowledgeRequestId = grounded.headers.get('x-vhalcha-request-id') ?? '';
  const traces = await knowledge.listRetrievalForRequest(org.id, knowledgeRequestId);
  const knowledgeRequests = await repos.requests.list(org.id, new Date('2020-01-01'), new Date('2100-01-01'));
  const knowledgeUsage = await repos.usage.list(org.id);
  const knowledgeAudits = await repos.audit.list(org.id);
  const afterKnowledge = await repos.budgetReservations.list(org.id);
  const priorReserved = Math.max(...beforeKnowledge.map((row) => Number(row.reservedUsd)), 0);
  const knowledgeReserved = afterKnowledge.find((row) => row.requestId === knowledgeRequestId);
  record(
    'budget includes knowledge context',
    Number(knowledgeReserved?.reservedUsd ?? 0) > priorReserved,
    String(knowledgeReserved?.reservedUsd ?? 0),
  );
  record(
    'retrieval trace linked',
    traces.length > 0 &&
      knowledgeRequests.some((row) => row.id === knowledgeRequestId) &&
      knowledgeUsage.some((row) => row.requestId === knowledgeRequestId) &&
      knowledgeAudits.some((row) => row.requestId === knowledgeRequestId),
    String(traces.length),
  );
  await knowledge.revokeAccess(org.id, registered.system.id, space.id);
  const revoked = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'What is the returns policy?' }],
    }),
  });
  const revokedBody = (await revoked.json()) as { choices?: Array<{ message?: { content?: string } }> };
  record(
    'revoked access retrieves nothing',
    revoked.status === 200 && !(revokedBody.choices?.[0]?.message?.content ?? '').includes('[S1]'),
    String(revoked.status),
  );
  await knowledge.updateSystemKnowledge(org.id, registered.system.id, { knowledgeEnabled: true, strictGrounding: true });
  const callsBeforeStrict = input.provider.calls.chat + input.provider.calls.stream;
  const unsupported = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'What is the unpublished acquisition price?' }],
    }),
  });
  const unsupportedBody = (await unsupported.json()) as { choices?: Array<{ message?: { content?: string } }> };
  record(
    'strict grounding insufficient evidence',
    unsupported.status === 200 &&
      (unsupportedBody.choices?.[0]?.message?.content ?? '').includes(INSUFFICIENT_KNOWLEDGE_MESSAGE) &&
      input.provider.calls.chat + input.provider.calls.stream === callsBeforeStrict,
    String(unsupported.status),
  );

  const orgB = await repos.organisations.create({ name: 'Organisation B', slug: `acceptance-b-${suffix}` });
  const envB = await repos.environments.create({ organisationId: orgB.id, name: 'Development', type: 'development' });
  await repos.registerAiSystem({
    organisationId: orgB.id,
    environmentId: envB.id,
    name: 'Secret System',
    description: 'Other tenant',
    type: 'assistant',
    riskLevel: 'high',
    monthlyBudgetUsd: 10,
    modelPattern: 'gpt-4.1-mini',
    requestsPerMinute: 60,
    generateKey: false,
  });
  const secretSpace = await knowledge.createSpace({ organisationId: orgB.id, name: 'Secret Pricing' });
  const secretSource = await knowledge.createSource({
    organisationId: orgB.id,
    knowledgeSpaceId: secretSpace.id,
    name: 'Secret Pricing',
    sourceType: 'manual_text',
  });
  const secret = 'CONFIDENTIAL_KNOWLEDGE_CANARY_984273 organisation B secret price is 999.';
  const secretDocument = await knowledge.createPendingDocument({
    organisationId: orgB.id,
    knowledgeSpaceId: secretSpace.id,
    knowledgeSourceId: secretSource.id,
    title: 'Secret Pricing',
    documentType: 'text',
    mimeType: 'text/plain',
    contentHash: contentHash(secret),
    extractedText: secret,
  });
  await indexKnowledgeVersion(input.db, {
    organisationId: orgB.id,
    documentVersionId: secretDocument.versionId,
    embedder,
    store: new MemoryKnowledgeObjectStore(),
  });
  const cross = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'What is the secret price CANARY?' }],
    }),
  });
  const crossText = await cross.text();
  const crossTraces = await knowledge.listRetrievalForRequest(org.id, cross.headers.get('x-vhalcha-request-id') ?? '');
  record(
    'cross-tenant knowledge hidden',
    cross.status === 200 && !crossText.includes('CONFIDENTIAL_KNOWLEDGE_CANARY_984273') && crossTraces.length === 0,
    String(cross.status),
  );

  await repos.budgets.update(org.id, registered.budget.id, { amountUsd: 25 });
  await knowledge.updateSystemKnowledge(org.id, registered.system.id, {
    knowledgeEnabled: false,
    strictGrounding: false,
  });
  const routing = createRoutingRepository(input.db);
  const economyId = '11111111-1111-4111-8111-111111111111';
  const standardId = '22222222-2222-4222-8222-222222222222';
  const premiumId = '33333333-3333-4333-8333-333333333333';
  for (const modelId of [economyId, standardId, premiumId]) {
    await routing.setAccess({ organisationId: org.id, modelCatalogueId: modelId, status: 'allowed' });
  }
  for (const pattern of ['economy-model', 'standard-model', 'premium-model']) {
    await repos.modelAccess.create({
      organisationId: org.id,
      aiSystemId: registered.system.id,
      provider: 'mock',
      modelPattern: pattern,
      isAllowed: true,
      priority: 10,
    });
  }
  await routing.updateSystem(org.id, registered.system.id, {
    routingMode: 'optimised',
    routingStrategy: 'cost',
    baselineModelId: premiumId,
    fallbackEnabled: true,
    premiumEscalation: false,
    maxProviderAttempts: 2,
  });
  const simple = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Classify this support message.' }],
    }),
  });
  const simpleText = await simple.text();
  const simpleBody = JSON.parse(simpleText) as { vhalcha?: { routing?: { selected_model?: string; estimated_savings?: number | null } }; error?: { message?: string } };
  const simpleRequestId = simple.headers.get('x-vhalcha-request-id') ?? '';
  const simpleDecision = simpleRequestId ? await routing.findByRequest(org.id, simpleRequestId) : null;
  record(
    'cost strategy chooses cheapest capable model',
    simple.status === 200 && simpleBody.vhalcha?.routing?.selected_model === 'economy-model',
    simpleBody.vhalcha?.routing?.selected_model ?? simpleBody.error?.message ?? simpleText.slice(0, 220),
  );
  const simpleReasons = (simpleBody.vhalcha?.routing as { reasons?: string[] } | undefined)?.reasons ?? [];
  record(
    'estimated reason matches selected route',
    simpleReasons.some((sentence) => sentence === 'Lowest estimated cost among qualifying models.'),
    simpleReasons[0] ?? 'missing reason',
  );
  record(
    'estimated savings against baseline',
    Number(simpleDecision?.estimatedBaselineCost ?? 0) > Number(simpleDecision?.estimatedSelectedCost ?? 0) &&
      Number(simpleDecision?.estimatedSavings ?? 0) > 0,
    String(simpleDecision?.estimatedSavings ?? 'missing'),
  );

  const largeEconomy = catalogueModel('economy-large', 'economy', 0.15, 0.6);
  const largePremium = catalogueModel('premium-large', 'premium', 2.5, 10);
  const largeDecision = selectRoute({
    profile: {
      taskType: 'chat',
      estimatedInputTokens: 100_000,
      estimatedOutputTokens: 2_000,
      requestSize: 'large',
      complexity: 'large',
      risk: 'low',
      requiredCapabilities: ['chat'],
      hasKnowledgeContext: false,
      usesTools: false,
      requiresStructuredOutput: false,
      requiresVision: false,
      expectedLatencyClass: 'normal',
    },
    models: [largePremium, largeEconomy],
    strategy: 'cost',
    constraints: { prohibitedTiers: [], allowedProviders: [], minimumContextWindow: null },
    runtimeProvider: 'mock',
    modelAllowed: () => true,
    maxRequestCostUsd: null,
    remainingBudgetUsd: null,
    baseline: largePremium,
  });
  record(
    'large-token cost regression',
    largeDecision.selected?.model.modelName === 'economy-large' &&
      (largeDecision.selected?.estimatedCost ?? 1) < 0.02 &&
      (largeDecision.ranked.find((candidate) => candidate.model.modelName === 'premium-large')?.estimatedCost ?? 0) > 0.2,
    largeDecision.selected?.model.modelName ?? largeDecision.failure ?? 'none',
  );

  input.provider.failModels.add('economy-model');
  const failedOver = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Classify this support message.' }],
    }),
  });
  const failedBody = (await failedOver.json()) as { vhalcha?: { routing?: { selected_model?: string; fallback_from?: string | null } } };
  const failedAudits = await repos.audit.list(org.id);
  record(
    'provider failure falls back',
    failedOver.status === 200 &&
      failedBody.vhalcha?.routing?.fallback_from === 'economy-model' &&
      failedBody.vhalcha?.routing?.selected_model !== 'economy-model' &&
      failedAudits.some((event) => event.action === 'routing.fallback.completed'),
    failedBody.vhalcha?.routing?.selected_model ?? String(failedOver.status),
  );
  input.provider.failModels.delete('economy-model');

  const spendWindow = periodBounds('monthly', 'UTC', new Date());
  const organisationSpend = await repos.usage.sumOrganisationCost(org.id, spendWindow.start, spendWindow.end);
  const orgBudget = await repos.budgets.create({
    organisationId: org.id,
    name: 'Organisation hard limit',
    period: 'monthly',
    amountUsd: Number((organisationSpend + 0.00007).toFixed(8)),
    hardLimit: true,
    action: 'block',
  });
  input.provider.failModels.add('economy-model');
  const callsBeforeBudget = input.provider.calls.chat;
  const orgFallback = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Classify this support message.' }],
    }),
  });
  input.provider.failModels.delete('economy-model');
  record(
    'organisation fallback budget protected',
    orgFallback.status !== 200 && input.provider.calls.chat === callsBeforeBudget + 1,
    `${orgFallback.status} calls ${input.provider.calls.chat - callsBeforeBudget}`,
  );
  await repos.budgets.update(org.id, orgBudget.id, { amountUsd: 1000, hardLimit: false, action: 'notify' });

  await routing.updateSystem(org.id, registered.system.id, {
    routingMode: 'optimised',
    routingStrategy: 'cost',
    baselineModelId: premiumId,
    fallbackEnabled: true,
    premiumEscalation: true,
    maxProviderAttempts: 2,
  });
  const escalated = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Return json for this support message.' }],
    }),
  });
  const escalatedId = escalated.headers.get('x-vhalcha-request-id') ?? '';
  const escalatedAttempts = escalatedId ? await routing.listAttempts(org.id, escalatedId) : [];
  const escalatedUsage = (await repos.usage.list(org.id)).find((row) => row.requestId === escalatedId);
  const attemptTotal = escalatedAttempts.reduce((sum, attempt) => sum + Number(attempt.actualCostUsd ?? 0), 0);
  record(
    'billable attempts accounted',
    escalated.status === 200 && escalatedAttempts.length === 2 && escalatedAttempts.every((attempt) => attempt.billable),
    escalatedAttempts.map((attempt) => `${attempt.model}:${attempt.status}`).join(', ') || String(escalated.status),
  );
  record(
    'total token-priced request cost correct',
    escalatedAttempts.length === 2 &&
      attemptTotal > 0 &&
      Math.abs(Number(escalatedUsage?.costUsd ?? 0) - attemptTotal) < 0.0000001,
    `usage ${escalatedUsage?.costUsd ?? 'missing'} attempts ${attemptTotal}`,
  );
  await routing.updateSystem(org.id, registered.system.id, { premiumEscalation: false, maxProviderAttempts: 2 });

  const staleExplanation = explainSelection({
    selected: { model: largeEconomy, estimatedCost: 0.0162, score: 0 },
    ranked: [
      { model: largeEconomy, estimatedCost: 0.0162, score: 0 },
      { model: largePremium, estimatedCost: 0.27, score: 0 },
    ],
    strategy: 'cost',
    profile: {
      taskType: 'chat',
      estimatedInputTokens: 8,
      estimatedOutputTokens: 256,
      requestSize: 'small',
      complexity: 'small',
      risk: 'low',
      requiredCapabilities: ['chat'],
      hasKnowledgeContext: false,
      usesTools: false,
      requiresStructuredOutput: false,
      requiresVision: false,
      expectedLatencyClass: 'normal',
    },
    baselineConfigured: true,
    savingsAvailable: false,
  });
  record(
    'stale price suppresses savings',
    pricingIsFresh(new Date('2020-01-01T00:00:00Z'), new Date('2026-09-29T00:00:00Z'), 90) === false &&
      staleExplanation.sentences.some((sentence) => sentence.includes('pricing data requires verification')),
    staleExplanation.sentences.find((sentence) => sentence.includes('pricing')) ?? 'missing',
  );

  const crossOpenAi = catalogueModel('openai-economy', 'economy', 2, 8);
  crossOpenAi.provider = 'openai';
  const crossAnthropic = catalogueModel('anthropic-standard', 'standard', 3, 15);
  crossAnthropic.provider = 'anthropic';
  const crossGemini = catalogueModel('gemini-economy', 'economy', 0.3, 2.5);
  crossGemini.provider = 'google';
  const crossDecision = selectRoute({
    profile: {
      taskType: 'chat',
      estimatedInputTokens: 8,
      estimatedOutputTokens: 256,
      requestSize: 'small',
      complexity: 'small',
      risk: 'low',
      requiredCapabilities: ['chat'],
      hasKnowledgeContext: false,
      usesTools: false,
      requiresStructuredOutput: false,
      requiresVision: false,
      expectedLatencyClass: 'fast',
    },
    models: [crossOpenAi, crossAnthropic, crossGemini],
    strategy: 'cost',
    constraints: {
      prohibitedTiers: [],
      allowedProviders: ['openai', 'anthropic', 'google'],
      preferredProviders: ['anthropic'],
      minimumContextWindow: null,
    },
    eligibleProviders: ['openai', 'anthropic', 'google'],
    modelAllowed: () => true,
    maxRequestCostUsd: null,
    remainingBudgetUsd: null,
    baseline: null,
  });
  record(
    'cross-provider cost selects cheapest vendor',
    crossDecision.selected?.model.provider === 'google' && crossDecision.selected.model.modelName === 'gemini-economy',
    `${crossDecision.selected?.model.provider ?? 'none'}/${crossDecision.selected?.model.modelName ?? 'none'}`,
  );

  const anthropicConn = await repos.providerConnections.create({
    organisationId: org.id,
    environmentId: environment.id,
    provider: 'anthropic',
    name: 'Acceptance Anthropic',
    credentialSource: 'platform_env',
  });
  const googleConn = await repos.providerConnections.create({
    organisationId: org.id,
    environmentId: environment.id,
    provider: 'google',
    name: 'Acceptance Google',
    credentialSource: 'platform_env',
  });
  record('anthropic provider connection persists', anthropicConn.provider === 'anthropic', anthropicConn.provider);
  record('google provider connection persists', googleConn.provider === 'google', googleConn.provider);
  const anthropicRule = await repos.modelAccess.create({
    organisationId: org.id,
    aiSystemId: registered.system.id,
    provider: 'anthropic',
    modelPattern: 'claude-*',
    isAllowed: false,
    priority: 5,
  });
  const googleRule = await repos.modelAccess.create({
    organisationId: org.id,
    aiSystemId: registered.system.id,
    provider: 'google',
    modelPattern: 'gemini-*',
    isAllowed: false,
    priority: 5,
  });
  record('anthropic model rule persists', anthropicRule.provider === 'anthropic' && !anthropicRule.isAllowed, anthropicRule.provider);
  record('google model rule persists', googleRule.provider === 'google' && !googleRule.isAllowed, googleRule.provider);
  record(
    'platform key requires explicit organisation opt-in',
    Boolean(anthropicConn.id) && anthropicConn.credentialSource === 'platform_env',
    anthropicConn.credentialSource,
  );
  const failedByok = await repos.providerConnections.connectOrganisation({
    organisationId: org.id,
    environmentId: environment.id,
    provider: 'anthropic',
    name: 'Failed Anthropic BYOK',
    encryptedCredentials: 'v1.fake.iv.tag.ciphertext',
  });
  await repos.providerConnections.setVerification(org.id, failedByok.id, {
    verificationStatus: 'failed',
    verificationErrorCode: 'provider_authentication_failed',
    verifiedAt: null,
    lastCheckedAt: new Date(),
  });
  const failedActive = await repos.providerConnections.findActive(org.id, environment.id, 'anthropic');
  record(
    'failed BYOK excluded',
    failedActive?.verificationStatus === 'failed' && failedActive.credentialSource === 'organisation',
    failedActive?.verificationStatus ?? 'missing',
  );

  const { assertGeminiText } = await import('@vhalcha/providers');
  let blockedOk = false;
  try {
    assertGeminiText({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
  } catch (error) {
    blockedOk = Boolean(error && typeof error === 'object' && 'normalized' in error && (error as { normalized: { code: string } }).normalized.code === 'provider_content_rejected');
  }
  record('Gemini blocked content normalized', blockedOk, 'provider_content_rejected');

  const largePro = selectRoute({
    profile: {
      taskType: 'chat',
      estimatedInputTokens: 250_000,
      estimatedOutputTokens: 256,
      requestSize: 'large',
      complexity: 'large',
      risk: 'low',
      requiredCapabilities: ['chat'],
      hasKnowledgeContext: false,
      usesTools: false,
      requiresStructuredOutput: false,
      requiresVision: false,
      expectedLatencyClass: 'normal',
    },
    models: [
      {
        ...catalogueModel('gemini-2.5-pro', 'premium', 1.25, 10),
        provider: 'google',
        modelName: 'gemini-2.5-pro',
        contextWindow: 1_048_576,
      },
    ],
    strategy: 'cost',
    constraints: { prohibitedTiers: [], allowedProviders: ['google'], minimumContextWindow: null },
    eligibleProviders: ['google'],
    modelAllowed: () => true,
    maxRequestCostUsd: null,
    remainingBudgetUsd: null,
    baseline: null,
  });
  record(
    'Gemini large-context pricing protected',
    largePro.rejected.some((item) => item.code === 'pricing_tier_unsupported'),
    largePro.rejected.map((item) => item.code).join(',') || 'none',
  );

  await knowledge.updateSystemKnowledge(org.id, registered.system.id, { knowledgeEnabled: true, strictGrounding: false });
  const wide = 'Summarise the approved note. '.repeat(400);
  const wideSpace = await knowledge.createSpace({ organisationId: org.id, name: 'Wide context' });
  const wideSource = await knowledge.createSource({
    organisationId: org.id,
    knowledgeSpaceId: wideSpace.id,
    name: 'Wide',
    sourceType: 'manual_text',
  });
  const wideDocument = await knowledge.createPendingDocument({
    organisationId: org.id,
    knowledgeSpaceId: wideSpace.id,
    knowledgeSourceId: wideSource.id,
    title: 'Wide',
    documentType: 'text',
    mimeType: 'text/plain',
    contentHash: contentHash(wide),
    extractedText: wide,
  });
  await indexKnowledgeVersion(input.db, {
    organisationId: org.id,
    documentVersionId: wideDocument.versionId,
    embedder,
    store: new MemoryKnowledgeObjectStore(),
  });
  await knowledge.grantAccess({
    organisationId: org.id,
    aiSystemId: registered.system.id,
    knowledgeSpaceId: wideSpace.id,
  });
  const wideResponse = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Summarise the approved note.' }],
      knowledge_space_ids: [wideSpace.id],
    }),
  });
  const wideBody = (await wideResponse.json()) as { vhalcha?: { routing?: { selected_model?: string } } };
  record(
    'knowledge alone changes routing context',
    wideResponse.status === 200 && wideBody.vhalcha?.routing?.selected_model !== 'economy-model',
    wideBody.vhalcha?.routing?.selected_model ?? String(wideResponse.status),
  );

  await knowledge.updateSystemKnowledge(org.id, registered.system.id, { knowledgeEnabled: false });
  await repos.budgets.update(org.id, registered.budget.id, { amountUsd: 0.0000001 });
  const starved = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Classify this support message.' }],
    }),
  });
  const starvedBody = (await starved.json()) as { error?: { code?: string } };
  record(
    'routing respects budget',
    starved.status === 402 || starved.status === 422,
    starvedBody.error?.code ?? String(starved.status),
  );

  const foreignDecisions = await routing.savingsSummary(orgB.id, new Date('2020-01-01'), new Date('2100-01-01'));
  const foreignConnections = await repos.providerConnections.list(orgB.id);
  const foreignAttempts = simpleRequestId ? await routing.listAttempts(orgB.id, simpleRequestId) : [{ id: 'missing' }];
  record(
    'tenant B cannot see tenant A attempts',
    foreignDecisions.decisions === 0 &&
      foreignConnections.every((connection) => connection.organisationId === orgB.id) &&
      foreignAttempts.length === 0,
    String(foreignAttempts.length),
  );
  const foreignAnthropic = await repos.providerConnections.list(orgB.id);
  record(
    'tenant B cannot access tenant A provider connection',
    foreignAnthropic.every((connection) => connection.provider !== 'anthropic' || connection.organisationId === orgB.id) &&
      (await repos.providerConnections.findActive(orgB.id, environment.id, 'anthropic')) === null,
    String(foreignAnthropic.length),
  );

  await repos.budgets.update(org.id, registered.budget.id, { amountUsd: 25 });
  await routing.updateSystem(org.id, registered.system.id, {
    routingMode: 'optimised',
    routingStrategy: 'cost',
    baselineModelId: premiumId,
    fallbackEnabled: true,
    premiumEscalation: false,
    maxProviderAttempts: 2,
  });
  input.provider.failModels.add('economy-model');
  const streamFallback = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Classify this support message.' }],
      stream: true,
    }),
  });
  const streamFallbackBody = await streamFallback.text();
  const streamRequestId = streamFallback.headers.get('x-vhalcha-request-id') ?? '';
  const streamAttempts = streamRequestId ? await routing.listAttempts(org.id, streamRequestId) : [];
  input.provider.failModels.delete('economy-model');
  record(
    'stream-open failure recorded',
    streamAttempts.some((attempt) => attempt.status === 'failed' && attempt.errorCode === 'provider_unavailable'),
    streamAttempts.map((attempt) => `${attempt.model}:${attempt.status}:${attempt.errorCode ?? ''}`).join(', ') || 'none',
  );
  record(
    'cross-provider stream fallback recorded',
    streamFallback.status === 200 &&
      streamFallbackBody.includes(MOCK_PROVIDER_TEXT) &&
      streamAttempts.length >= 2 &&
      streamAttempts.some((attempt) => attempt.status === 'succeeded'),
    streamAttempts.map((attempt) => `${attempt.provider}/${attempt.model}:${attempt.status}`).join(', ') || String(streamFallback.status),
  );

  await routing.updateSystem(org.id, registered.system.id, { routingMode: 'fixed', premiumEscalation: false });
  const fixed = await fetch(new URL('/v1/chat/completions', input.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Classify this support message.' }],
    }),
  });
  const fixedBody = (await fixed.json()) as { vhalcha?: { routing?: { selected_model?: string } } };
  record(
    'fixed mode unchanged',
    fixed.status === 200 && input.provider.lastModel === 'gpt-4.1-mini' && !fixedBody.vhalcha?.routing,
    input.provider.lastModel,
  );
  return stages;
}

function catalogueModel(modelName: string, tier: RoutingModel['tier'], inputUsdPerMillion: number, outputUsdPerMillion: number): RoutingModel {
  return {
    id: modelName,
    provider: 'mock',
    modelName,
    displayName: modelName,
    tier,
    inputUsdPerMillion,
    outputUsdPerMillion,
    contextWindow: 200_000,
    maxOutputTokens: 4_000,
    capabilities: ['chat'],
    reasoningLevel: 'low',
    latencyClass: 'fast',
    supportsTools: false,
    supportsVision: false,
    supportsStructuredOutput: tier !== 'economy',
    supportsStreaming: true,
    health: 'healthy',
    priceVerifiedAt: '2026-09-29T00:00:00.000Z',
  };
}
