import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { auditActions, type AuditDraft } from '@vhalcha/audit';
import { BUDGET_RESERVATION_TTL_MS, estimateReservationTokens, evaluateBudgets, periodBounds } from '@vhalcha/budgets';
import {
  BudgetReservationRejected,
  createRepositories,
  createRoutingRepository,
  findVirtualKeyByHash,
  organisations,
  type AppDatabase,
} from '@vhalcha/database';
import { logGatewayRequest, type ErrorTracker } from '@vhalcha/logger';
import { decideModelAccess } from '@vhalcha/policies';
import { calculateTokenCost, type ModelProvider, type NormalizedUsage, type ProviderRegistry, type UnitPrice } from '@vhalcha/providers';
import { consumeRateLimit, redisKeys, type KeyValueStore, type RateLimitDecision } from '@vhalcha/redis';
import { hashVirtualApiKey, isVirtualApiKeyShape, verifyVirtualApiKeyHash } from '@vhalcha/security';
import { chatCompletionRequestSchema, GatewayError, type ChatCompletionRequest } from '@vhalcha/types';
import { buildUsageDraft } from '@vhalcha/usage';
import { noteGuardResponse, writeGuardEvents } from './guard-live';
import { knowledgeExtension, recordKnowledgeUse } from './knowledge';
import type { Metrics } from './metrics';
import { moveToFallback, noteProviderHealth, recordRoutingDecision, resolveProviderApiKey, routingExtension, type GatewayRoute } from './route';

export interface PlatformProviderKeys {
  openai?: string;
  anthropic?: string;
  google?: string;
}

export interface GatewayDeps {
  db: AppDatabase;
  redis: KeyValueStore;
  /** @deprecated Prefer providers registry. Kept so older tests can inject a single adapter. */
  provider?: ModelProvider;
  providers?: ProviderRegistry;
  platformKeys?: PlatformProviderKeys;
  /** @deprecated Use platformKeys.openai */
  openAiApiKey: string;
  logger: Logger;
  metrics: Metrics;
  tracker?: ErrorTracker;
  now?: () => Date;
  embedder?: import('@vhalcha/knowledge').EmbeddingProvider;
  /**
   * mock: only mock catalogue models are eligible.
   * multi: OpenAI, Anthropic and Google adapters compete when credentials exist.
   */
  routingRuntime?: 'mock' | 'multi';
  /** Deployment switch. False leaves the V1.2 path unchanged. Defaults to enabled. */
  guardEnabled?: boolean;
  /** Allows an organisation that has chosen Protect to execute supported actions. */
  protectModeEnabled?: boolean;
  /** Catalogue prices older than this are not used for savings. Default 90 days. */
  maxPricingAgeDays?: number;
}

export interface PreparedChat {
  requestId: string;
  startedAt: Date;
  body: ChatCompletionRequest;
  organisationId: string;
  environmentId: string;
  aiSystemId: string;
  virtualApiKeyId: string;
  keyHash: string;
  timezone: string;
  policyResult: 'allowed' | 'warning';
  rateLimit: RateLimitDecision;
  idempotencyKey: string | null;
  provider: string;
  knowledge?: import('./knowledge').GatewayKnowledge;
  routing?: GatewayRoute | null;
  /** Sum of token-priced cost from provider attempts that returned usage. */
  billableActualUsd: number;
  billableInputTokens: number;
  billableOutputTokens: number;
  providerAttemptCount: number;
  guard?: import('./guard-live').LiveGuardState;
}

type IdempotencyState = 'in_progress' | 'completed' | 'retryable_failed' | 'terminal_failed';

interface IdempotencyRecord {
  state: IdempotencyState | 'pending' | 'failed';
  requestId: string;
  fingerprint: string;
  createdAt: string;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function nowOf(deps: GatewayDeps) {
  return deps.now?.() ?? new Date();
}

function normalizedProviderError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object' && 'normalized' in error) {
    const normalized = (error as { normalized?: { code?: string; message?: string } }).normalized;
    if (normalized?.code && normalized.message) {
      return { code: normalized.code, message: normalized.message };
    }
  }
  return { code: 'provider_error', message: 'The model provider returned an error.' };
}

function gatewayProviderFailure(error: unknown): { code: 'provider_error' | 'provider_unavailable' | 'provider_credentials_missing'; message: string } {
  const normalized = normalizedProviderError(error);
  if (normalized.code === 'provider_authentication_failed') {
    return { code: 'provider_credentials_missing', message: 'Authentication rejected.' };
  }
  if (
    normalized.code === 'provider_unavailable' ||
    normalized.code === 'provider_timeout' ||
    normalized.code === 'provider_rate_limited'
  ) {
    return { code: 'provider_unavailable', message: normalized.message };
  }
  return { code: 'provider_error', message: normalized.message };
}

/** Resolve the vendor for a fixed-mode request from the catalogue. Optimised mode overwrites this. */
async function resolveFixedProvider(deps: GatewayDeps, modelName: string): Promise<string> {
  if (deps.routingRuntime === 'mock') {
    return 'openai';
  }
  const catalogue = await createRoutingRepository(deps.db).listCatalogue();
  const matches = catalogue.filter((row) => row.modelName === modelName);
  if (matches.length === 1) {
    return matches[0]!.provider;
  }
  const openai = matches.find((row) => row.provider === 'openai');
  if (openai) {
    return 'openai';
  }
  return matches[0]?.provider ?? 'openai';
}

export function resolveModelProvider(deps: GatewayDeps, providerId: string): ModelProvider {
  const fromRegistry = deps.providers?.get(providerId);
  if (fromRegistry) {
    return fromRegistry;
  }
  if (deps.provider && (providerId === deps.provider.id || providerId === 'openai' || providerId === 'mock')) {
    return deps.provider;
  }
  throw new GatewayError('provider_unavailable', 'The model provider is unavailable.');
}

function platformKey(deps: GatewayDeps, provider: string): string {
  if (provider === 'anthropic') {
    return deps.platformKeys?.anthropic ?? '';
  }
  if (provider === 'google') {
    return deps.platformKeys?.google ?? '';
  }
  return deps.platformKeys?.openai ?? deps.openAiApiKey ?? '';
}

async function catalogueUnitPrice(deps: GatewayDeps, provider: string, model: string): Promise<UnitPrice | null> {
  const row = await createRoutingRepository(deps.db).findCatalogueModel(provider, model);
  if (!row) {
    return null;
  }
  const price = {
    inputUsdPerMillion: Number(row.inputUsdPerMillion),
    outputUsdPerMillion: Number(row.outputUsdPerMillion),
    cachedInputUsdPerMillion:
      row.cachedInputUsdPerMillion === null || row.cachedInputUsdPerMillion === undefined
        ? null
        : Number(row.cachedInputUsdPerMillion),
  };
  if (!Number.isFinite(price.inputUsdPerMillion) || !Number.isFinite(price.outputUsdPerMillion)) {
    return null;
  }
  return price;
}

function addBillable(prepared: PreparedChat, usage: NormalizedUsage, costUsd: number) {
  prepared.billableActualUsd = Number((prepared.billableActualUsd + costUsd).toFixed(8));
  prepared.billableInputTokens += usage.inputTokens;
  prepared.billableOutputTokens += usage.outputTokens;
}

async function priceUsage(deps: GatewayDeps, provider: string, model: string, usage: NormalizedUsage | null) {
  if (!usage) {
    return null;
  }
  const priced = calculateTokenCost({
    price: await catalogueUnitPrice(deps, provider, model),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    inputIncludesCached: usage.inputIncludesCached,
  });
  return priced.pricingKnown ? priced.costUsd : null;
}

async function recordProviderAttempt(
  deps: GatewayDeps,
  prepared: PreparedChat,
  input: {
    provider: string;
    model: string;
    reason: string;
    status: 'succeeded' | 'failed' | 'escalated';
    usage: NormalizedUsage | null;
    estimatedCostUsd: number | null;
    actualCostUsd: number | null;
    errorCode: string | null;
    billable: boolean;
    startedAt: Date;
    completedAt: Date;
  },
) {
  prepared.providerAttemptCount += 1;
  const attemptNumber = prepared.providerAttemptCount;
  await createRoutingRepository(deps.db).recordAttempt({
    organisationId: prepared.organisationId,
    requestId: prepared.requestId,
    routingDecisionId: prepared.routing?.decisionId ?? null,
    attemptNumber,
    provider: input.provider,
    model: input.model,
    reason: input.reason,
    status: input.status,
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    estimatedCostUsd: input.estimatedCostUsd,
    actualCostUsd: input.actualCostUsd,
    errorCode: input.errorCode,
    billable: input.billable,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

export function rateHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(decision.remaining),
    'x-ratelimit-reset': String(decision.resetAtEpochSeconds),
  };
}

async function safeRedis<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

export async function prepareChat(deps: GatewayDeps, request: FastifyRequest): Promise<PreparedChat> {
  const startedAt = nowOf(deps);
  const repos = createRepositories(deps.db);
  deps.metrics.increment('request_count');
  try {
    await deps.db.select({ id: organisations.id }).from(organisations).limit(1);
  } catch {
    throw new GatewayError(
      'control_plane_unavailable',
      'The control plane cannot enforce policy right now.',
    );
  }

  const header = request.headers.authorization;
  const rawKey = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!rawKey || !isVirtualApiKeyShape(rawKey)) {
    throw new GatewayError('invalid_api_key', 'The provided Vhalcha API key is invalid.');
  }
  const keyHash = hashVirtualApiKey(rawKey);
  const cacheKey = redisKeys.key(keyHash);
  const record = await findVirtualKeyByHash(deps.db, keyHash);
  if (record) {
    await safeRedis(async () => {
      await deps.redis.set(
        cacheKey,
        JSON.stringify({ id: record.id, status: record.status, organisationId: record.organisationId }),
        15,
      );
    }, undefined);
  }
  if (!record || !verifyVirtualApiKeyHash(rawKey, record.keyHash)) {
    throw new GatewayError('invalid_api_key', 'The provided Vhalcha API key is invalid.');
  }
  if (record.status === 'revoked' || (record.expiresAt && new Date(record.expiresAt) <= startedAt)) {
    await repos.audit.create(record.organisationId, {
      organisationId: record.organisationId,
      environmentId: record.environmentId,
      actorType: 'api',
      actorId: record.id,
      action: auditActions.requestBlocked,
      resourceType: 'virtual_api_key',
      resourceId: record.id,
      result: 'failure',
      severity: 'warning',
      metadata: { ai_system_id: record.aiSystemId, error_code: 'api_key_revoked' },
    });
    throw new GatewayError(
      'api_key_revoked',
      record.status === 'revoked'
        ? 'The provided Vhalcha API key has been revoked.'
        : 'The provided Vhalcha API key has expired.',
    );
  }

  const organisation = await repos.organisations.findById(record.organisationId);
  const system = await repos.aiSystems.findById(record.organisationId, record.aiSystemId);
  const environment = await repos.environments.findById(record.organisationId, record.environmentId);
  if (!organisation || organisation.status !== 'active' || !environment) {
    throw new GatewayError('organisation_unavailable', 'This organisation cannot send AI requests.');
  }
  if (!system || system.status === 'disabled' || system.status === 'offline') {
    if (system) {
      await blockRequest(deps, {
        organisationId: organisation.id,
        aiSystemId: system.id,
        environmentId: environment.id,
        virtualApiKeyId: record.id,
        model: 'unresolved',
        startedAt,
        errorCode: 'system_disabled',
        message: 'The AI system is disabled.',
        policyType: 'system_status',
        policyName: 'AI system status',
        severity: 'warning',
      });
    }
    throw new GatewayError('system_disabled', 'The AI system is disabled.');
  }

  const parsed = chatCompletionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new GatewayError('invalid_request', 'The request body is invalid.');
  }
  const body = parsed.data;

  let rateLimit: RateLimitDecision;
  try {
    rateLimit = await consumeRateLimit(deps.redis, {
      organisationId: organisation.id,
      aiSystemId: system.id,
      limit: system.requestsPerMinute,
      now: startedAt,
    });
  } catch {
    throw new GatewayError(
      'rate_limiter_unavailable',
      'Rate limiting is unavailable. The request was not sent to the provider.',
    );
  }
  if (!rateLimit.allowed) {
    deps.metrics.increment('rate_limit_blocks');
    const violations = await safeRedis(
      () =>
        deps.redis.incr(
          redisKeys.rateViolations(
            organisation.id,
            system.id,
            Math.floor(startedAt.getTime() / 1000 / 60),
          ),
          120,
        ),
      0,
    );
    await blockRequest(deps, {
      organisationId: organisation.id,
      aiSystemId: system.id,
      environmentId: environment.id,
      virtualApiKeyId: record.id,
      model: body.model,
      startedAt,
      errorCode: 'rate_limit_exceeded',
      message: 'The AI system rate limit has been exceeded.',
      policyType: 'rate_limit',
      policyName: 'Requests per minute',
      severity: violations >= 5 ? 'critical' : 'warning',
      httpStatus: 429,
    });
    throw new GatewayError(
      'rate_limit_exceeded',
      'The AI system rate limit has been exceeded.',
      {
        ...rateHeaders({ ...rateLimit, remaining: 0 }),
        'retry-after': String(Math.max(rateLimit.resetAtEpochSeconds - Math.floor(startedAt.getTime() / 1000), 1)),
      },
    );
  }

  const optimised = system.routingMode === 'optimised';
  const provider = await resolveFixedProvider(deps, body.model);
  const rules = optimised ? [] : await repos.modelAccess.listForSystem(organisation.id, system.id);
  const modelDecision = optimised
    ? { allowed: true, matchedRule: null }
    : decideModelAccess(
    rules.map((rule) => ({
      id: rule.id,
      provider: rule.provider,
      modelPattern: rule.modelPattern,
      isAllowed: rule.isAllowed,
      priority: rule.priority,
    })),
    provider,
    body.model,
  );
  if (!modelDecision.allowed) {
    await blockRequest(deps, {
      organisationId: organisation.id,
      aiSystemId: system.id,
      environmentId: environment.id,
      virtualApiKeyId: record.id,
      model: body.model,
      startedAt,
      errorCode: 'model_not_allowed',
      message: 'The requested model is not allowed for this AI system.',
      policyType: 'model_access',
      policyName: 'Model access',
      severity: 'warning',
      httpStatus: 403,
    });
    throw new GatewayError('model_not_allowed', 'The requested model is not allowed for this AI system.');
  }

  const applicable = await repos.budgets.applicable(organisation.id, system.id, environment.id);
  const hardBudget = applicable.some((budget) => budget.hardLimit || budget.action === 'block');
  if (!optimised && hardBudget && !(await catalogueUnitPrice(deps, provider, body.model))) {
    await blockRequest(deps, {
      organisationId: organisation.id,
      aiSystemId: system.id,
      environmentId: environment.id,
      virtualApiKeyId: record.id,
      model: body.model,
      startedAt,
      errorCode: 'pricing_unknown',
      message: 'This model has no Vhalcha price and cannot be used while a hard budget is active.',
      policyType: 'pricing',
      policyName: 'Known model price',
      severity: 'warning',
      httpStatus: 403,
      metadata: { pricing_unknown: true },
    });
    throw new GatewayError(
      'pricing_unknown',
      'This model has no Vhalcha price and cannot be used while a hard budget is active.',
    );
  }

  const connection = await repos.providerConnections.findActive(organisation.id, environment.id, provider);
  if (!optimised) {
    const platformOk =
      connection?.credentialSource === 'platform_env' && Boolean(platformKey(deps, provider));
    const byokOk =
      connection?.credentialSource === 'organisation' &&
      connection.status === 'active' &&
      connection.verificationStatus === 'verified';
    if (!platformOk && !byokOk) {
      throw new GatewayError('provider_unavailable', 'The model provider is unavailable.');
    }
  } else if (deps.routingRuntime === 'mock') {
    // Mock catalogue models do not require a BYOK connection.
  } else {
    const anyConnection = (await repos.providerConnections.list(organisation.id)).some((row) => {
      if (row.environmentId !== environment.id || row.status !== 'active') {
        return false;
      }
      if (row.credentialSource === 'platform_env') {
        return Boolean(platformKey(deps, row.provider));
      }
      return row.credentialSource === 'organisation' && row.verificationStatus === 'verified';
    });
    if (!anyConnection) {
      throw new GatewayError('provider_credentials_missing', 'This AI system has no active provider credential.');
    }
  }

  const idempotencyHeader = request.headers['idempotency-key'];
  const idempotencyKey =
    !body.stream && typeof idempotencyHeader === 'string' && idempotencyHeader.length > 0 && idempotencyHeader.length <= 200
      ? idempotencyHeader
      : null;

  return {
    requestId: randomUUID(),
    startedAt,
    body,
    organisationId: organisation.id,
    environmentId: environment.id,
    aiSystemId: system.id,
    virtualApiKeyId: record.id,
    keyHash,
    timezone: organisation.timezone,
    policyResult: 'allowed',
    rateLimit,
    idempotencyKey,
    provider,
    billableActualUsd: 0,
    billableInputTokens: 0,
    billableOutputTokens: 0,
    providerAttemptCount: 0,
  };
}

async function blockRequest(
  deps: GatewayDeps,
  input: {
    organisationId: string;
    aiSystemId: string;
    environmentId: string;
    virtualApiKeyId: string;
    model: string;
    startedAt: Date;
    errorCode: string;
    message: string;
    policyType: string;
    policyName: string;
    severity: 'warning' | 'critical';
    httpStatus?: number;
    metadata?: Record<string, unknown>;
    provider?: string;
  },
) {
  const repos = createRepositories(deps.db);
  const requestId = randomUUID();
  const completedAt = nowOf(deps);
  await repos.requests.create({
    id: requestId,
    organisationId: input.organisationId,
    aiSystemId: input.aiSystemId,
    environmentId: input.environmentId,
    virtualApiKeyId: input.virtualApiKeyId,
    provider: input.provider ?? 'unresolved',
    model: input.model,
    status: 'blocked',
    policyResult: 'blocked',
    startedAt: input.startedAt,
    completedAt,
    httpStatus: input.httpStatus ?? 403,
    errorCode: input.errorCode,
    errorMessageSafe: input.message,
  });
  await repos.policyEvents.create({
    organisationId: input.organisationId,
    aiSystemId: input.aiSystemId,
    requestId,
    policyType: input.policyType,
    policyName: input.policyName,
    result: 'blocked',
    severity: input.severity,
    details: { ai_system_id: input.aiSystemId, error_code: input.errorCode, ...(input.metadata ?? {}) },
  });
  await writeAudit(deps, {
    organisationId: input.organisationId,
    environmentId: input.environmentId,
    actorType: 'api',
    actorId: input.virtualApiKeyId,
    action: auditActions.requestBlocked,
    resourceType: 'request',
    resourceId: requestId,
    result: 'blocked',
    severity: input.severity,
    requestId,
    metadata: { ai_system_id: input.aiSystemId, model: input.model, error_code: input.errorCode },
  });
  logGatewayRequest(deps.logger, {
    request_id: requestId,
    organisation_id: input.organisationId,
    ai_system_id: input.aiSystemId,
    provider: input.provider ?? 'unresolved',
    model: input.model,
    status: 'blocked',
    latency_ms: completedAt.getTime() - input.startedAt.getTime(),
  });
}

async function writeAudit(deps: GatewayDeps, draft: AuditDraft) {
  await createRepositories(deps.db).audit.create(draft.organisationId, draft);
}

function requestFingerprint(body: ChatCompletionRequest): string {
  const canonical = JSON.stringify({
    max_tokens: body.max_tokens ?? null,
    messages: body.messages.map((message) => ({ content: message.content, role: message.role })),
    model: body.model,
    stream: Boolean(body.stream),
    temperature: body.temperature ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function idempotencyRedisKey(prepared: PreparedChat) {
  return redisKeys.idempotency(
    prepared.organisationId,
    prepared.virtualApiKeyId,
    prepared.idempotencyKey ?? '',
  );
}

export type IdempotencyClaim =
  | { kind: 'skip' }
  | { kind: 'owner' }
  | { kind: 'completed'; requestId: string }
  | { kind: 'conflict' };

export async function claimIdempotency(deps: GatewayDeps, prepared: PreparedChat): Promise<IdempotencyClaim> {
  if (!prepared.idempotencyKey) {
    return { kind: 'skip' };
  }
  const key = idempotencyRedisKey(prepared);
  const fingerprint = requestFingerprint(prepared.body);
  let existing: string | null;
  try {
    existing = await deps.redis.get(key);
  } catch {
    throw new GatewayError(
      'control_plane_unavailable',
      'Idempotency storage is unavailable. The request was not sent to the provider.',
    );
  }
  if (existing) {
    const parsed = JSON.parse(existing) as IdempotencyRecord;
    deps.logger.info(
      { request_id: parsed.requestId, event: 'idempotency_duplicate' },
      'idempotency duplicate',
    );
    if (parsed.fingerprint !== fingerprint) {
      return { kind: 'conflict' };
    }
    if (parsed.state === 'pending' || parsed.state === 'in_progress') {
      return { kind: 'conflict' };
    }
    if (parsed.state === 'retryable_failed') {
      const replacement: IdempotencyRecord = {
        state: 'in_progress',
        requestId: prepared.requestId,
        fingerprint,
        createdAt: nowOf(deps).toISOString(),
      };
      await deps.redis.set(key, JSON.stringify(replacement), IDEMPOTENCY_TTL_SECONDS);
      return { kind: 'owner' };
    }
    return { kind: 'completed', requestId: parsed.requestId };
  }
  const record: IdempotencyRecord = {
    state: 'in_progress',
    requestId: prepared.requestId,
    fingerprint,
    createdAt: nowOf(deps).toISOString(),
  };
  let locked = false;
  try {
    locked = await deps.redis.setIfAbsent(key, JSON.stringify(record), IDEMPOTENCY_TTL_SECONDS);
  } catch {
    throw new GatewayError(
      'control_plane_unavailable',
      'Idempotency storage is unavailable. The request was not sent to the provider.',
    );
  }
  if (!locked) {
    throw new GatewayError('idempotency_conflict', 'A request with this idempotency key is already in progress.');
  }
  return { kind: 'owner' };
}

export async function clearIdempotency(deps: GatewayDeps, prepared: PreparedChat) {
  if (!prepared.idempotencyKey) {
    return;
  }
  await safeRedis(() => deps.redis.del(idempotencyRedisKey(prepared)), undefined);
}

export async function markIdempotency(deps: GatewayDeps, prepared: PreparedChat, state: IdempotencyState) {
  if (!prepared.idempotencyKey) {
    return;
  }
  const record: IdempotencyRecord = {
    state,
    requestId: prepared.requestId,
    fingerprint: requestFingerprint(prepared.body),
    createdAt: nowOf(deps).toISOString(),
  };
  await safeRedis(
    () => deps.redis.set(idempotencyRedisKey(prepared), JSON.stringify(record), IDEMPOTENCY_TTL_SECONDS),
    undefined,
  );
}

export async function enforceBudget(deps: GatewayDeps, prepared: PreparedChat) {
  const repos = createRepositories(deps.db);
  const applicable = await repos.budgets.applicable(
    prepared.organisationId,
    prepared.aiSystemId,
    prepared.environmentId,
  );
  const tokens = estimateReservationTokens(prepared.body.messages, prepared.body.max_tokens);
  const priced = calculateTokenCost({
    price: await catalogueUnitPrice(deps, prepared.provider, prepared.body.model),
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
  });
  const hardBudget = applicable.some((budget) => budget.hardLimit || budget.action === 'block');
  if (hardBudget && priced.costUsd === null) {
    throw new GatewayError(
      'pricing_unknown',
      'This model has no Vhalcha price and cannot be used while a hard budget is active.',
    );
  }
  const periods = applicable.map((budget) => {
    const bounds = periodBounds(budget.period === 'daily' ? 'daily' : 'monthly', prepared.timezone, prepared.startedAt);
    return { budgetId: budget.id, start: bounds.start, end: bounds.end };
  });
  try {
    const reserved = await repos.budgetReservations.reserve({
      organisationId: prepared.organisationId,
      aiSystemId: prepared.aiSystemId,
      environmentId: prepared.environmentId,
      requestId: prepared.requestId,
      estimatedUsd: priced.costUsd ?? 0,
      now: prepared.startedAt,
      expiresAt: new Date(prepared.startedAt.getTime() + BUDGET_RESERVATION_TTL_MS),
      periods,
    });
    deps.logger.info(
      {
        request_id: prepared.requestId,
        organisation_id: prepared.organisationId,
        ai_system_id: prepared.aiSystemId,
        reserved_usd: reserved.estimatedUsd,
        event: 'budget_reserved',
      },
      'budget reserved',
    );
    const decision = evaluateBudgets(reserved.snapshots);
    for (const warning of decision.warnings) {
      prepared.policyResult = 'warning';
      await repos.policyEvents.create({
        organisationId: prepared.organisationId,
        aiSystemId: prepared.aiSystemId,
        policyType: 'budget',
        policyName: warning.name,
        result: 'warning',
        severity: 'warning',
        details: {
          ai_system_id: prepared.aiSystemId,
          spend_usd: warning.spendUsd,
          amount_usd: warning.amountUsd,
          threshold_percent: warning.warningThresholdPercent,
        },
      });
    }
  } catch (error) {
    if (error instanceof BudgetReservationRejected) {
      deps.metrics.increment('budget_blocks');
      deps.logger.info(
        {
          request_id: prepared.requestId,
          organisation_id: prepared.organisationId,
          ai_system_id: prepared.aiSystemId,
          budget_id: error.budgetId,
          event: 'budget_reservation_rejected',
        },
        'budget reservation rejected',
      );
      await markIdempotency(deps, prepared, 'terminal_failed');
      await blockRequest(deps, {
        organisationId: prepared.organisationId,
        aiSystemId: prepared.aiSystemId,
        environmentId: prepared.environmentId,
        virtualApiKeyId: prepared.virtualApiKeyId,
        model: prepared.body.model,
        startedAt: prepared.startedAt,
        errorCode: 'budget_exceeded',
        message: 'The AI system budget has been exceeded.',
        policyType: 'budget',
        policyName: error.budgetName,
        severity: 'critical',
        httpStatus: 402,
        metadata: { spend_usd: error.spendUsd, amount_usd: error.amountUsd },
      });
      throw new GatewayError('budget_exceeded', 'The AI system budget has been exceeded.');
    }
    throw error;
  }
}

async function chatWithFallback(deps: GatewayDeps, prepared: PreparedChat) {
  for (;;) {
    const startedAt = nowOf(deps);
    const provider = prepared.provider;
    const model = prepared.body.model;
    const estimatedCostUsd = prepared.routing?.ranked[prepared.routing.attempt]?.estimatedCost ?? null;
    try {
      const apiKey = await resolveProviderApiKey(deps, prepared);
      const adapter = resolveModelProvider(deps, prepared.provider);
      const result = await adapter.chatCompletion(prepared.body, { apiKey });
      const content = assistantContent(result.responseBody);
      const actual = await priceUsage(deps, provider, model, result.usage);
      const escalate =
        prepared.routing?.premiumEscalation &&
        prepared.routing.profile.requiresStructuredOutput &&
        !content.includes('{');
      if (actual !== null && result.usage) {
        addBillable(prepared, result.usage, actual);
      }
      if (escalate) {
        const moved = await moveToFallback(deps, prepared, 'invalid_structured_response');
        await recordProviderAttempt(deps, prepared, {
          provider,
          model,
          reason: moved ? 'invalid_structured_response' : 'selected',
          status: moved ? 'escalated' : 'succeeded',
          usage: result.usage,
          estimatedCostUsd,
          actualCostUsd: actual,
          errorCode: null,
          billable: actual !== null,
          startedAt,
          completedAt: nowOf(deps),
        });
        if (moved) {
          continue;
        }
      } else {
        await recordProviderAttempt(deps, prepared, {
          provider,
          model,
          reason: prepared.routing?.fallbackReason ?? 'selected',
          status: 'succeeded',
          usage: result.usage,
          estimatedCostUsd,
          actualCostUsd: actual,
          errorCode: null,
          billable: actual !== null,
          startedAt,
          completedAt: nowOf(deps),
        });
      }
      await noteProviderHealth(deps, prepared, 'success');
      return result;
    } catch (error) {
      const normalized = normalizedProviderError(error);
      await recordProviderAttempt(deps, prepared, {
        provider,
        model,
        reason: 'provider_error',
        status: 'failed',
        usage: null,
        estimatedCostUsd,
        actualCostUsd: null,
        errorCode: normalized.code,
        billable: false,
        startedAt,
        completedAt: nowOf(deps),
      });
      if (normalized.code !== 'provider_content_rejected') {
        await noteProviderHealth(deps, prepared, 'failure', normalized.code);
      }
      const moved = await moveToFallback(deps, prepared, normalized.code);
      if (!moved) {
        throw error;
      }
    }
  }
}

async function openStreamWithFallback(deps: GatewayDeps, prepared: PreparedChat, signal: AbortSignal) {
  for (;;) {
    const startedAt = nowOf(deps);
    const provider = prepared.provider;
    const model = prepared.body.model;
    const estimatedCostUsd = prepared.routing?.ranked[prepared.routing.attempt]?.estimatedCost ?? null;
    try {
      const apiKey = await resolveProviderApiKey(deps, prepared);
      const adapter = resolveModelProvider(deps, prepared.provider);
      const opened = await adapter.streamChatCompletion(prepared.body, { apiKey, signal });
      return opened;
    } catch (error) {
      const normalized = normalizedProviderError(error);
      await recordProviderAttempt(deps, prepared, {
        provider,
        model,
        reason: 'provider_error',
        status: 'failed',
        usage: null,
        estimatedCostUsd,
        actualCostUsd: null,
        errorCode: normalized.code,
        billable: false,
        startedAt,
        completedAt: nowOf(deps),
      });
      if (normalized.code !== 'provider_content_rejected') {
        await noteProviderHealth(deps, prepared, 'failure', normalized.code);
      }
      const moved = await moveToFallback(deps, prepared, normalized.code);
      if (!moved) {
        throw error;
      }
    }
  }
}

export async function completeChat(deps: GatewayDeps, prepared: PreparedChat) {
  const repos = createRepositories(deps.db);
  await repos.requests.create({
    id: prepared.requestId,
    organisationId: prepared.organisationId,
    aiSystemId: prepared.aiSystemId,
    environmentId: prepared.environmentId,
    virtualApiKeyId: prepared.virtualApiKeyId,
    provider: prepared.provider,
    model: prepared.body.model,
    status: 'pending',
    policyResult: prepared.policyResult,
    startedAt: prepared.startedAt,
  });
  await writeGuardEvents(deps, prepared);
  await repos.requests.markProviderStarted(prepared.organisationId, prepared.requestId);
  await recordKnowledgeUse(deps, prepared);
  await recordRoutingDecision(deps, prepared);
  try {
    const result = await chatWithFallback(deps, prepared);
    const usage = result.usage;
    const completedAt = nowOf(deps);
    await finalizeSuccess(deps, prepared, usage, {
      status: 'succeeded',
      httpStatus: 200,
      providerLatencyMs: result.providerLatencyMs,
      timeToFirstTokenMs: null,
      completedAt,
    });
    await markIdempotency(deps, prepared, 'completed');
    noteGuardResponse(deps, prepared, false, assistantContent(result.responseBody));
    const content = assistantContent(result.responseBody);
    const knowledge = knowledgeExtension(prepared.knowledge, content);
    const routing = routingExtension(prepared.routing, prepared.billableActualUsd);
    if ((!knowledge && !routing) || !result.responseBody || typeof result.responseBody !== 'object') {
      return result.responseBody;
    }
    return { ...result.responseBody, vhalcha: { ...(knowledge ? { knowledge } : {}), ...(routing ? { routing } : {}) } };
  } catch (error) {
    const failure = gatewayProviderFailure(error);
    deps.metrics.increment('provider_errors');
    await finalizeFailure(deps, prepared, failure.code, failure.message);
    await markIdempotency(deps, prepared, prepared.billableActualUsd > 0 ? 'terminal_failed' : 'retryable_failed');
    throw new GatewayError(failure.code, failure.message);
  }
}

export async function streamChat(deps: GatewayDeps, prepared: PreparedChat, raw: ServerResponse) {
  const repos = createRepositories(deps.db);
  await repos.requests.create({
    id: prepared.requestId,
    organisationId: prepared.organisationId,
    aiSystemId: prepared.aiSystemId,
    environmentId: prepared.environmentId,
    virtualApiKeyId: prepared.virtualApiKeyId,
    provider: prepared.provider,
    model: prepared.body.model,
    status: 'pending',
    policyResult: prepared.policyResult,
    startedAt: prepared.startedAt,
  });
  await writeGuardEvents(deps, prepared);
  await repos.requests.markProviderStarted(prepared.organisationId, prepared.requestId);
  await recordKnowledgeUse(deps, prepared);
  await recordRoutingDecision(deps, prepared);
  noteGuardResponse(deps, prepared, true);
  const abort = new AbortController();
  raw.on?.('close', () => {
    if (!raw.writableEnded) {
      abort.abort();
    }
  });
  let opened;
  try {
    opened = await openStreamWithFallback(deps, prepared, abort.signal);
  } catch (error) {
    const failure = gatewayProviderFailure(error);
    deps.metrics.increment('provider_errors');
    await finalizeFailure(deps, prepared, failure.code, failure.message);
    await markIdempotency(deps, prepared, prepared.billableActualUsd > 0 ? 'terminal_failed' : 'retryable_failed');
    throw new GatewayError(failure.code, failure.message);
  }
  raw.writeHead?.(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-vhalcha-request-id': prepared.requestId,
    ...rateHeaders(prepared.rateLimit),
  });
  let disconnected = false;
  let assembled = '';
  try {
    for await (const chunk of opened.chunks) {
      if (raw.destroyed) {
        disconnected = true;
        abort.abort();
        break;
      }
      assembled = appendStreamText(assembled, chunk);
      raw.write(chunk);
    }
  } catch {
    disconnected = true;
  }
  const completedAt = nowOf(deps);
  const streamUsage = opened.usage();
  const streamActual = await priceUsage(deps, prepared.provider, prepared.body.model, streamUsage);
  if (streamActual !== null && streamUsage) {
    addBillable(prepared, streamUsage, streamActual);
  }
  if (disconnected) {
    await recordProviderAttempt(deps, prepared, {
      provider: prepared.provider,
      model: prepared.body.model,
      reason: 'client_disconnected',
      status: 'failed',
      usage: streamUsage,
      estimatedCostUsd: prepared.routing?.ranked[prepared.routing.attempt]?.estimatedCost ?? null,
      actualCostUsd: streamActual,
      errorCode: 'client_disconnected',
      billable: streamActual !== null,
      startedAt: prepared.startedAt,
      completedAt,
    });
    await noteProviderHealth(deps, prepared, 'failure');
    await finalizeFailure(
      deps,
      prepared,
      'client_disconnected',
      'The client disconnected before the stream completed.',
      opened.usage(),
      opened.timeToFirstTokenMs(),
      opened.providerLatencyMs(),
    );
    await markIdempotency(deps, prepared, prepared.billableActualUsd > 0 ? 'terminal_failed' : 'retryable_failed');
    raw.end?.();
    return;
  }
  await recordProviderAttempt(deps, prepared, {
    provider: prepared.provider,
    model: prepared.body.model,
    reason: prepared.routing?.fallbackReason ?? 'selected',
    status: 'succeeded',
    usage: streamUsage,
    estimatedCostUsd: prepared.routing?.ranked[prepared.routing.attempt]?.estimatedCost ?? null,
    actualCostUsd: streamActual,
    errorCode: null,
    billable: streamActual !== null,
    startedAt: prepared.startedAt,
    completedAt,
  });
  await noteProviderHealth(deps, prepared, 'success');
  await finalizeSuccess(deps, prepared, opened.usage(), {
    status: 'succeeded',
    httpStatus: 200,
    providerLatencyMs: opened.providerLatencyMs(),
    timeToFirstTokenMs: opened.timeToFirstTokenMs(),
    completedAt,
  });
  await markIdempotency(deps, prepared, 'completed');
  const knowledge = knowledgeExtension(prepared.knowledge, assembled);
  const routing = routingExtension(prepared.routing, prepared.billableActualUsd);
  if (knowledge || routing) {
    raw.write(`data: ${JSON.stringify({ vhalcha: { ...(knowledge ? { knowledge } : {}), ...(routing ? { routing } : {}) } })}\n\n`);
  }
  raw.end?.();
}

async function usageDraftForRequest(deps: GatewayDeps, prepared: PreparedChat, usage: NormalizedUsage | null) {
  if (prepared.providerAttemptCount > 0 && (prepared.billableInputTokens > 0 || prepared.billableOutputTokens > 0 || prepared.billableActualUsd > 0)) {
    return {
      provider: prepared.provider,
      model: prepared.body.model,
      inputTokens: prepared.billableInputTokens,
      outputTokens: prepared.billableOutputTokens,
      totalTokens: prepared.billableInputTokens + prepared.billableOutputTokens,
      costUsd: prepared.billableActualUsd,
      pricingKnown: true,
    };
  }
  if (!usage) {
    return null;
  }
  return buildUsageDraft({
    provider: prepared.provider,
    model: prepared.body.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    price: await catalogueUnitPrice(deps, prepared.provider, prepared.body.model),
  });
}

function assistantContent(body: unknown): string {
  if (!body || typeof body !== 'object' || !('choices' in body)) {
    return '';
  }
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function appendStreamText(assembled: string, chunk: unknown): string {
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString('utf8')
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString('utf8')
      : String(chunk ?? '');
  let next = assembled;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) {
      continue;
    }
    try {
      const payload = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: unknown } }> };
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') {
        next += delta;
      }
    } catch {
      continue;
    }
  }
  return next;
}

async function finalizeSuccess(
  deps: GatewayDeps,
  prepared: PreparedChat,
  usage: NormalizedUsage | null,
  timing: {
    status: string;
    httpStatus: number;
    providerLatencyMs: number;
    timeToFirstTokenMs: number | null;
    completedAt: Date;
  },
) {
  const repos = createRepositories(deps.db);
  const draft = await usageDraftForRequest(deps, prepared, usage);
  const latencyMs = timing.completedAt.getTime() - prepared.startedAt.getTime();
  const outcome = await repos.finalizeGatewayRequest({
    organisationId: prepared.organisationId,
    requestId: prepared.requestId,
    aiSystemId: prepared.aiSystemId,
    virtualApiKeyId: prepared.virtualApiKeyId,
    completedAt: timing.completedAt,
    requestPatch: {
      status: timing.status,
      httpStatus: timing.httpStatus,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      estimatedCostUsd: draft?.costUsd === null || draft === null ? null : draft.costUsd.toFixed(8),
      latencyMs,
      providerLatencyMs: timing.providerLatencyMs,
      timeToFirstTokenMs: timing.timeToFirstTokenMs,
      policyResult: draft && !draft.pricingKnown ? 'warning' : prepared.policyResult,
      errorCode: draft && !draft.pricingKnown ? 'pricing_unknown' : null,
      errorMessageSafe: null,
      provider: prepared.provider,
      model: prepared.body.model,
    },
    usage: draft,
    audit: {
      organisationId: prepared.organisationId,
      environmentId: prepared.environmentId,
      actorType: 'api',
      actorId: prepared.virtualApiKeyId,
      action: auditActions.requestCompleted,
      resourceType: 'request',
      resourceId: prepared.requestId,
      result: 'success',
      severity: 'info',
      requestId: prepared.requestId,
      metadata: {
        ai_system_id: prepared.aiSystemId,
        model: prepared.body.model,
        provider: prepared.provider,
        total_tokens: usage?.totalTokens ?? 0,
        cost_usd: draft?.costUsd,
        pricing_unknown: draft ? !draft.pricingKnown : false,
      },
    },
  });
  if (!outcome.duplicate) {
    deps.logger.info(
      {
        request_id: prepared.requestId,
        organisation_id: prepared.organisationId,
        ai_system_id: prepared.aiSystemId,
        reserved_usd: outcome.reservedUsd,
        actual_usd: outcome.actualUsd,
        event: 'budget_reconciled',
      },
      'budget reconciled',
    );
  }
  deps.metrics.observeLatency(latencyMs);
  logGatewayRequest(deps.logger, {
    request_id: prepared.requestId,
    organisation_id: prepared.organisationId,
    ai_system_id: prepared.aiSystemId,
    provider: prepared.provider,
    model: prepared.body.model,
    status: timing.status,
    latency_ms: latencyMs,
  });
}

async function finalizeFailure(
  deps: GatewayDeps,
  prepared: PreparedChat,
  errorCode: string,
  message: string,
  usage: NormalizedUsage | null = null,
  timeToFirstTokenMs: number | null = null,
  providerLatencyMs: number | null = null,
) {
  const completedAt = nowOf(deps);
  const repos = createRepositories(deps.db);
  const draft = await usageDraftForRequest(deps, prepared, usage);
  const outcome = await repos.finalizeGatewayRequest({
    organisationId: prepared.organisationId,
    requestId: prepared.requestId,
    aiSystemId: prepared.aiSystemId,
    virtualApiKeyId: prepared.virtualApiKeyId,
    completedAt,
    requestPatch: {
      status: 'failed',
      httpStatus: 502,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      estimatedCostUsd: draft?.costUsd === null || draft === null ? null : draft.costUsd.toFixed(8),
      latencyMs: completedAt.getTime() - prepared.startedAt.getTime(),
      providerLatencyMs,
      timeToFirstTokenMs,
      errorCode,
      errorMessageSafe: message,
    },
    usage: draft,
    audit: {
      organisationId: prepared.organisationId,
      environmentId: prepared.environmentId,
      actorType: 'api',
      actorId: prepared.virtualApiKeyId,
      action: auditActions.requestFailed,
      resourceType: 'request',
      resourceId: prepared.requestId,
      result: 'failure',
      severity: 'warning',
      requestId: prepared.requestId,
      metadata: { ai_system_id: prepared.aiSystemId, model: prepared.body.model, error_code: errorCode },
    },
  });
  deps.logger.info(
    {
      request_id: prepared.requestId,
      organisation_id: prepared.organisationId,
      ai_system_id: prepared.aiSystemId,
      event: draft ? 'budget_reconciled' : 'budget_reservation_released',
      duplicate: outcome.duplicate,
    },
    draft ? 'budget reconciled' : 'budget reservation released',
  );
  deps.metrics.increment('errors');
}
