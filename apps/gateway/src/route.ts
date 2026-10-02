import { auditActions } from '@vhalcha/audit';
import { periodBounds } from '@vhalcha/budgets';
import { BudgetReservationRejected, createRepositories, createRoutingRepository } from '@vhalcha/database';
import { decideModelAccess } from '@vhalcha/policies';
import { decryptSecret } from '@vhalcha/security';
import {
  HeuristicRequestClassifier,
  effectiveHealth,
  explainSelection,
  pricingIsFresh,
  selectRoute,
  type RequestProfile,
  type RankedCandidate,
  type RouteExplanation,
  type RoutingConstraints,
  type RoutingModel,
  type RoutingStrategy,
} from '@vhalcha/routing';
import { GatewayError } from '@vhalcha/types';
import type { GatewayDeps, PreparedChat } from './pipeline';

export interface GatewayRoute {
  mode: 'optimised';
  strategy: RoutingStrategy;
  profile: RequestProfile;
  ranked: RankedCandidate[];
  reasons: string[];
  explanation: RouteExplanation | null;
  estimatedSelectedCost: number | null;
  estimatedBaselineCost: number | null;
  /** Pre-request estimate. Not realized savings and not the provider invoice. */
  estimatedSavings: number | null;
  savingsAvailable: boolean;
  pricingVerifiedAt: string | null;
  nextCheapestCost: number | null;
  qualifyingCount: number;
  rejected: Array<{ modelName: string; provider: string; code: string }>;
  maxAttempts: number;
  fallbackEnabled: boolean;
  premiumEscalation: boolean;
  attempt: number;
  decisionId: string | null;
  fallbackFrom: string | null;
  fallbackReason: string | null;
  recorded: boolean;
}

const classifier = new HeuristicRequestClassifier();

function constraintsOf(value: unknown): RoutingConstraints {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const tiers = Array.isArray(record.prohibited_tiers)
    ? record.prohibited_tiers.filter((item) => item === 'economy' || item === 'standard' || item === 'premium')
    : [];
  const providers = Array.isArray(record.allowed_providers)
    ? record.allowed_providers.filter((item): item is string => typeof item === 'string')
    : [];
  const prohibited = Array.isArray(record.prohibited_providers)
    ? record.prohibited_providers.filter((item): item is string => typeof item === 'string')
    : [];
  const preferred = Array.isArray(record.preferred_providers)
    ? record.preferred_providers.filter((item): item is string => typeof item === 'string')
    : [];
  const minimum = typeof record.minimum_context_window === 'number' ? record.minimum_context_window : null;
  return {
    prohibitedTiers: tiers,
    allowedProviders: providers,
    prohibitedProviders: prohibited,
    preferredProviders: preferred,
    minimumContextWindow: minimum,
  };
}

function platformKeyFor(deps: GatewayDeps, provider: string): string {
  if (provider === 'anthropic') {
    return deps.platformKeys?.anthropic ?? '';
  }
  if (provider === 'google') {
    return deps.platformKeys?.google ?? '';
  }
  return deps.platformKeys?.openai ?? deps.openAiApiKey ?? '';
}

/** Providers that currently have a usable credential path for this organisation and environment. */
export async function listEligibleProviders(deps: GatewayDeps, prepared: PreparedChat): Promise<string[]> {
  if (deps.routingRuntime === 'mock') {
    return ['mock'];
  }
  const eligible = new Set<string>();
  const connections = await createRepositories(deps.db).providerConnections.list(prepared.organisationId);
  for (const connection of connections) {
    if (connection.environmentId !== prepared.environmentId || connection.status !== 'active') {
      continue;
    }
    if (connection.credentialSource === 'vhalcha_managed') {
      continue;
    }
    if (connection.credentialSource === 'platform_env') {
      if (platformKeyFor(deps, connection.provider)) {
        eligible.add(connection.provider);
      }
      continue;
    }
    if (connection.credentialSource === 'organisation' && connection.verificationStatus === 'verified') {
      eligible.add(connection.provider);
    }
  }
  return [...eligible];
}

function asTier(value: string): RoutingModel['tier'] {
  if (value === 'economy' || value === 'standard' || value === 'premium') {
    return value;
  }
  return 'standard';
}

export function routingExtension(route: GatewayRoute | null | undefined, actualTokenPricedCost: number | null = null) {
  if (!route) {
    return undefined;
  }
  return {
    mode: route.mode,
    strategy: route.strategy,
    task_type: route.profile.taskType,
    request_size: route.profile.requestSize,
    complexity: route.profile.complexity,
    risk: route.profile.risk,
    selected_provider: route.ranked[route.attempt]?.model.provider,
    selected_model: route.ranked[route.attempt]?.model.modelName,
    estimated_selected_cost: route.estimatedSelectedCost,
    estimated_baseline_cost: route.estimatedBaselineCost,
    estimated_route_savings: route.estimatedSavings,
    estimated_savings: route.estimatedSavings,
    savings_available: route.savingsAvailable,
    actual_routed_token_cost: actualTokenPricedCost,
    baseline: route.estimatedBaselineCost === null ? 'not_configured' : 'configured',
    reasons: route.reasons,
    qualifying_count: route.qualifyingCount,
    next_cheapest_cost: route.nextCheapestCost,
    pricing_verified_at: route.pricingVerifiedAt,
    fallback_from: route.fallbackFrom,
  };
}

export async function resolveProviderApiKey(deps: GatewayDeps, prepared: PreparedChat): Promise<string> {
  if (prepared.provider === 'mock' || deps.routingRuntime === 'mock') {
    return platformKeyFor(deps, 'openai') || 'mock-provider';
  }
  const connection = await createRepositories(deps.db).providerConnections.findActive(
    prepared.organisationId,
    prepared.environmentId,
    prepared.provider,
  );
  if (!connection || connection.status !== 'active') {
    throw new GatewayError('provider_credentials_missing', 'This AI system has no active provider credential.');
  }
  if (connection.credentialSource === 'vhalcha_managed') {
    throw new GatewayError('provider_unavailable', 'Vhalcha-managed provider credentials are not enabled.');
  }
  if (connection.credentialSource === 'platform_env') {
    const key = platformKeyFor(deps, prepared.provider);
    if (!key) {
      throw new GatewayError('provider_credentials_missing', 'The platform provider credential is not configured.');
    }
    return key;
  }
  if (connection.credentialSource !== 'organisation') {
    throw new GatewayError('provider_credentials_missing', 'This AI system has no active provider credential.');
  }
  if (connection.verificationStatus !== 'verified') {
    throw new GatewayError(
      'provider_credentials_missing',
      connection.verificationStatus === 'failed'
        ? 'The organisation provider credential failed verification.'
        : 'The organisation provider credential is not verified.',
    );
  }
  const secret = connection.encryptedCredentials;
  const keyMaterial = process.env.VHALCHA_SECRETS_KEY ?? '';
  if (!secret || !keyMaterial) {
    throw new GatewayError('provider_credentials_missing', 'The organisation provider credential is not configured.');
  }
  try {
    return decryptSecret(secret, keyMaterial);
  } catch {
    throw new GatewayError('provider_credentials_missing', 'The organisation provider credential could not be read.');
  }
}

export async function applyOptimisedRoute(deps: GatewayDeps, prepared: PreparedChat): Promise<void> {
  const repos = createRepositories(deps.db);
  const system = await repos.aiSystems.findById(prepared.organisationId, prepared.aiSystemId);
  if (!system || system.routingMode !== 'optimised') {
    return;
  }
  const routing = createRoutingRepository(deps.db);
  const eligibleProviders = await listEligibleProviders(deps, prepared);
  const [catalogue, access, health, rules, applicable] = await Promise.all([
    routing.listCatalogue(),
    routing.listAccess(prepared.organisationId),
    routing.listHealth(prepared.organisationId, prepared.environmentId),
    repos.modelAccess.listForSystem(prepared.organisationId, prepared.aiSystemId),
    repos.budgets.applicable(prepared.organisationId, prepared.aiSystemId, prepared.environmentId),
  ]);
  const accessByModel = new Map(access.map((row) => [row.modelCatalogueId, row]));
  const now = prepared.startedAt;
  const providerWideUnavailable = new Set(
    health
      .filter((item) => item.modelName === '' && effectiveHealth({
        status: item.status === 'degraded' || item.status === 'unavailable' ? item.status : 'healthy',
        consecutiveFailures: item.consecutiveFailures,
        cooldownUntil: item.cooldownUntil,
      }, now) === 'unavailable')
      .map((item) => item.provider),
  );
  const models: RoutingModel[] = [];
  for (const row of catalogue) {
    const grant = accessByModel.get(row.id);
    if (!grant || grant.status !== 'allowed') {
      continue;
    }
    if (providerWideUnavailable.has(row.provider)) {
      continue;
    }
    const healthRow = health.find((item) => item.provider === row.provider && item.modelName === row.modelName);
    models.push({
      id: row.id,
      provider: row.provider,
      modelName: row.modelName,
      displayName: row.displayName,
      tier: asTier(grant.tierOverride ?? row.tier),
      inputUsdPerMillion: Number(row.inputUsdPerMillion),
      outputUsdPerMillion: Number(row.outputUsdPerMillion),
      contextWindow: row.contextWindow,
      maxOutputTokens: row.maxOutputTokens,
      capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
      reasoningLevel: row.reasoningLevel === 'high' || row.reasoningLevel === 'medium' ? row.reasoningLevel : 'low',
      latencyClass: row.latencyClass === 'fast' || row.latencyClass === 'slow' ? row.latencyClass : 'normal',
      supportsTools: row.supportsTools,
      supportsVision: row.supportsVision,
      supportsStructuredOutput: row.supportsStructuredOutput,
      supportsStreaming: row.supportsStreaming,
      priceVerifiedAt: row.priceVerifiedAt ? row.priceVerifiedAt.toISOString() : null,
      health: effectiveHealth(
        healthRow
          ? {
              status: healthRow.status === 'degraded' || healthRow.status === 'unavailable' ? healthRow.status : 'healthy',
              consecutiveFailures: healthRow.consecutiveFailures,
              cooldownUntil: healthRow.cooldownUntil,
            }
          : null,
        now,
      ),
    });
  }
  const profile = classifier.classify({
    messages: prepared.body.messages,
    maxTokens: prepared.body.max_tokens,
    hasKnowledgeContext: Boolean(prepared.knowledge?.used && prepared.knowledge.retrieved.length > 0),
    systemRisk: system.riskLevel === 'critical' || system.riskLevel === 'high' || system.riskLevel === 'medium' ? system.riskLevel : 'low',
  });
  const periods = applicable.map((budget) => {
    const bounds = periodBounds(budget.period === 'daily' ? 'daily' : 'monthly', prepared.timezone, now);
    return { budgetId: budget.id, start: bounds.start, end: bounds.end };
  });
  const remaining = await repos.budgetReservations.headroom({
    organisationId: prepared.organisationId,
    aiSystemId: prepared.aiSystemId,
    environmentId: prepared.environmentId,
    now,
    periods,
  });
  const baselineRow = system.baselineModelId ? catalogue.find((row) => row.id === system.baselineModelId) ?? null : null;
  const baseline: RoutingModel | null = baselineRow
    ? {
        id: baselineRow.id,
        provider: baselineRow.provider,
        modelName: baselineRow.modelName,
        displayName: baselineRow.displayName,
        tier: asTier(baselineRow.tier),
        inputUsdPerMillion: Number(baselineRow.inputUsdPerMillion),
        outputUsdPerMillion: Number(baselineRow.outputUsdPerMillion),
        contextWindow: baselineRow.contextWindow,
        maxOutputTokens: baselineRow.maxOutputTokens,
        capabilities: baselineRow.capabilities,
        reasoningLevel: 'high',
        latencyClass: 'normal',
        supportsTools: baselineRow.supportsTools,
        supportsVision: baselineRow.supportsVision,
        supportsStructuredOutput: baselineRow.supportsStructuredOutput,
        supportsStreaming: baselineRow.supportsStreaming,
        health: 'healthy',
        priceVerifiedAt: baselineRow.priceVerifiedAt ? baselineRow.priceVerifiedAt.toISOString() : null,
      }
    : null;
  const strategy: RoutingStrategy =
    system.routingStrategy === 'cost' || system.routingStrategy === 'quality' || system.routingStrategy === 'latency'
      ? system.routingStrategy
      : 'balanced';
  const decision = selectRoute({
    profile,
    models,
    strategy,
    constraints: constraintsOf(system.routingConstraints),
    eligibleProviders,
    modelAllowed: (provider, modelName) =>
      decideModelAccess(
        rules.map((rule) => ({
          id: rule.id,
          provider: rule.provider,
          modelPattern: rule.modelPattern,
          isAllowed: rule.isAllowed,
          priority: rule.priority,
        })),
        provider,
        modelName,
      ).allowed,
    maxRequestCostUsd: system.maxRequestCostUsd === null ? null : Number(system.maxRequestCostUsd),
    remainingBudgetUsd: remaining,
    baseline,
  });
  deps.metrics.increment('routing_decisions');
  if (!decision.selected) {
    deps.metrics.increment('routing_rejections');
    const code = decision.failure === 'budget_exceeded' ? 'budget_exceeded' : decision.failure === 'context_too_large' ? 'context_too_large' : decision.failure === 'pricing_unknown' ? 'pricing_unknown' : 'no_compatible_model';
    const message =
      code === 'budget_exceeded'
        ? 'No approved model can serve this request within the remaining budget.'
        : code === 'context_too_large'
          ? 'No approved model can hold this request and its knowledge context.'
          : code === 'pricing_unknown'
            ? 'No approved model has usable pricing metadata.'
            : 'No approved model can satisfy this request.';
    throw new GatewayError(code, message);
  }
  const maxAgeDays = deps.maxPricingAgeDays ?? 90;
  const selectedVerified = decision.selected.model.priceVerifiedAt
    ? new Date(decision.selected.model.priceVerifiedAt)
    : null;
  const baselineVerified = baseline?.priceVerifiedAt ? new Date(baseline.priceVerifiedAt) : null;
  const savingsAvailable =
    baseline !== null &&
    pricingIsFresh(selectedVerified, now, maxAgeDays) &&
    pricingIsFresh(baselineVerified, now, maxAgeDays);
  const explanation = explainSelection({
    selected: decision.selected,
    ranked: decision.ranked,
    strategy,
    profile,
    baselineConfigured: baseline !== null,
    savingsAvailable,
  });
  prepared.provider = decision.selected.model.provider;
  prepared.body = { ...prepared.body, model: decision.selected.model.modelName };
  prepared.routing = {
    mode: 'optimised',
    strategy,
    profile,
    ranked: decision.ranked,
    reasons: explanation.sentences,
    explanation,
    estimatedSelectedCost: decision.selected.estimatedCost,
    estimatedBaselineCost: decision.estimatedBaselineCost,
    estimatedSavings: savingsAvailable ? decision.estimatedSavings : null,
    savingsAvailable,
    pricingVerifiedAt: selectedVerified ? selectedVerified.toISOString() : null,
    nextCheapestCost: explanation.nextCheapestCost,
    qualifyingCount: explanation.qualifyingCount,
    rejected: decision.rejected.filter((item) => item.code !== 'provider_not_runtime'),
    maxAttempts: Math.min(3, Math.max(1, system.maxProviderAttempts)),
    fallbackEnabled: system.fallbackEnabled,
    premiumEscalation: system.premiumEscalation,
    attempt: 0,
    decisionId: null,
    fallbackFrom: null,
    fallbackReason: null,
    recorded: false,
  };
}

export async function recordRoutingDecision(deps: GatewayDeps, prepared: PreparedChat) {
  if (!prepared.routing || prepared.routing.recorded) {
    return;
  }
  const selected = prepared.routing.ranked[prepared.routing.attempt];
  if (!selected) {
    return;
  }
  const decisionId = await createRoutingRepository(deps.db).recordDecision({
    organisationId: prepared.organisationId,
    requestId: prepared.requestId,
    aiSystemId: prepared.aiSystemId,
    routingMode: 'optimised',
    routingStrategy: prepared.routing.strategy,
    selectedProvider: selected.model.provider,
    selectedModel: selected.model.modelName,
    selectedModelId: selected.model.id,
    candidateCount: prepared.routing.ranked.length,
    complexity: prepared.routing.profile.complexity,
    risk: prepared.routing.profile.risk,
    estimatedInputTokens: prepared.routing.profile.estimatedInputTokens,
    estimatedOutputTokens: prepared.routing.profile.estimatedOutputTokens,
    estimatedSelectedCost: selected.estimatedCost,
    estimatedBaselineCost: prepared.routing.estimatedBaselineCost,
    estimatedSavings: prepared.routing.estimatedSavings,
    decisionReason: {
      reasons: prepared.routing.reasons,
      rejected: prepared.routing.rejected,
      task_type: prepared.routing.profile.taskType,
      request_size: prepared.routing.profile.requestSize,
      required_capabilities: prepared.routing.profile.requiredCapabilities,
      has_knowledge_context: prepared.routing.profile.hasKnowledgeContext,
      qualifying_count: prepared.routing.qualifyingCount,
      selected_estimated_cost: prepared.routing.estimatedSelectedCost,
      next_cheapest_cost: prepared.routing.nextCheapestCost,
      pricing_verified_at: prepared.routing.pricingVerifiedAt,
      savings_available: prepared.routing.savingsAvailable,
    },
  });
  prepared.routing.decisionId = decisionId;
  await createRepositories(deps.db).audit.create(prepared.organisationId, {
    organisationId: prepared.organisationId,
    environmentId: prepared.environmentId,
    actorType: 'api',
    actorId: prepared.virtualApiKeyId,
    action: auditActions.routingDecisionCreated,
    resourceType: 'routing_decision',
    resourceId: prepared.requestId,
    result: 'success',
    severity: 'info',
    requestId: prepared.requestId,
    metadata: {
      ai_system_id: prepared.aiSystemId,
      provider: selected.model.provider,
      model: selected.model.modelName,
      strategy: prepared.routing.strategy,
      complexity: prepared.routing.profile.complexity,
    },
  });
  prepared.routing.recorded = true;
}

export function nextFallback(prepared: PreparedChat): RankedCandidate | null {
  const route = prepared.routing;
  if (!route || !route.fallbackEnabled) {
    return null;
  }
  if (route.attempt + 1 >= route.maxAttempts) {
    return null;
  }
  const rest = route.ranked.slice(route.attempt + 1);
  if (rest.length === 0) {
    return null;
  }
  if (route.premiumEscalation) {
    const current = route.ranked[route.attempt]?.model.tier;
    const rank = { economy: 0, standard: 1, premium: 2 };
    const higher = rest.find((candidate) => current && rank[candidate.model.tier] > rank[current]);
    if (higher) {
      return higher;
    }
  }
  return rest[0] ?? null;
}

export async function moveToFallback(deps: GatewayDeps, prepared: PreparedChat, reason: string): Promise<boolean> {
  const route = prepared.routing;
  const next = nextFallback(prepared);
  if (!route || !next) {
    return false;
  }
  const previous = route.ranked[route.attempt];
  if (!previous) {
    return false;
  }
  try {
    const periods = (
      await createRepositories(deps.db).budgets.applicable(prepared.organisationId, prepared.aiSystemId, prepared.environmentId)
    ).map((budget) => {
      const bounds = periodBounds(budget.period === 'daily' ? 'daily' : 'monthly', prepared.timezone, prepared.startedAt);
      return { budgetId: budget.id, start: bounds.start, end: bounds.end };
    });
    const alreadyBilled = prepared.billableActualUsd;
    await createRepositories(deps.db).budgetReservations.raise({
      organisationId: prepared.organisationId,
      aiSystemId: prepared.aiSystemId,
      environmentId: prepared.environmentId,
      requestId: prepared.requestId,
      estimatedUsd: Number((alreadyBilled + next.estimatedCost).toFixed(8)),
      now: prepared.startedAt,
      periods,
    });
  } catch (error) {
    if (error instanceof BudgetReservationRejected) {
      return false;
    }
    throw error;
  }
  route.fallbackFrom = previous.model.modelName;
  route.fallbackReason = reason;
  route.attempt = route.ranked.indexOf(next);
  route.estimatedSelectedCost = next.estimatedCost;
  prepared.provider = next.model.provider;
  prepared.body = { ...prepared.body, model: next.model.modelName };
  deps.metrics.increment('routing_fallbacks');
  await createRoutingRepository(deps.db).markFallback(prepared.organisationId, prepared.requestId, previous.model.modelName, reason, {
    provider: next.model.provider,
    model: next.model.modelName,
    modelId: next.model.id,
    estimatedSelectedCost: next.estimatedCost,
  });
  await createRepositories(deps.db).audit.create(prepared.organisationId, {
    organisationId: prepared.organisationId,
    environmentId: prepared.environmentId,
    actorType: 'system',
    actorId: null,
    action: auditActions.routingFallbackCompleted,
    resourceType: 'routing_decision',
    resourceId: prepared.requestId,
    result: 'success',
    severity: 'warning',
    requestId: prepared.requestId,
    metadata: {
      ai_system_id: prepared.aiSystemId,
      fallback_from_provider: previous.model.provider,
      fallback_from: previous.model.modelName,
      model: next.model.modelName,
      provider: next.model.provider,
      reason,
    },
  });
  return true;
}

export async function noteProviderHealth(
  deps: GatewayDeps,
  prepared: PreparedChat,
  outcome: 'success' | 'failure',
  errorCode?: string,
) {
  if (!prepared.routing) {
    return;
  }
  const routing = createRoutingRepository(deps.db);
  const now = new Date();
  await routing.applyHealth({
    organisationId: prepared.organisationId,
    environmentId: prepared.environmentId,
    provider: prepared.provider,
    modelName: prepared.body.model,
    outcome,
    now,
  });
  const providerWide =
    outcome === 'failure' &&
    (errorCode === 'provider_unavailable' || errorCode === 'provider_timeout');
  if (providerWide) {
    await routing.applyHealth({
      organisationId: prepared.organisationId,
      environmentId: prepared.environmentId,
      provider: prepared.provider,
      modelName: '',
      outcome: 'failure',
      now,
    });
  }
  if (outcome === 'success') {
    await routing.applyHealth({
      organisationId: prepared.organisationId,
      environmentId: prepared.environmentId,
      provider: prepared.provider,
      modelName: '',
      outcome: 'success',
      now,
    });
  }
}
