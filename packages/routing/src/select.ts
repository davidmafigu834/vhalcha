import { capEstimateForModel, COST_TIE_TOLERANCE } from './estimate';
import { estimateModelCost } from './price';
import type {
  RankedCandidate,
  RejectedCandidate,
  RequestProfile,
  RouteExplanation,
  RouteSelection,
  RoutingConstraints,
  RoutingModel,
  RoutingStrategy,
} from './types';

const weights: Record<Exclude<RoutingStrategy, 'cost'>, { cost: number; quality: number; latency: number }> = {
  balanced: { cost: 0.4, quality: 0.35, latency: 0.25 },
  quality: { cost: 0.15, quality: 0.7, latency: 0.15 },
  latency: { cost: 0.15, quality: 0.15, latency: 0.7 },
};

const tierQuality = { economy: 0.25, standard: 0.6, premium: 1 };
const latencyScore = { fast: 1, normal: 0.65, slow: 0.35 };

function capabilityMissing(model: RoutingModel, required: string[]): string | null {
  for (const capability of required) {
    if (capability === 'tool_use' && !model.supportsTools) {
      return 'capability_missing';
    }
    if (capability === 'vision' && !model.supportsVision) {
      return 'capability_missing';
    }
    if (capability === 'structured_output' && !model.supportsStructuredOutput) {
      return 'capability_missing';
    }
    if (!model.capabilities.includes(capability) && !['tool_use', 'vision', 'structured_output'].includes(capability)) {
      return 'capability_missing';
    }
  }
  return null;
}

function costsTied(left: number, right: number): boolean {
  return Math.abs(left - right) <= COST_TIE_TOLERANCE;
}

function healthRank(health: RoutingModel['health']): number {
  return health === 'healthy' ? 0 : 1;
}

function latencyRank(latency: RoutingModel['latencyClass']): number {
  if (latency === 'fast') {
    return 0;
  }
  if (latency === 'normal') {
    return 1;
  }
  return 2;
}

function tierRank(tier: RoutingModel['tier']): number {
  if (tier === 'economy') {
    return 0;
  }
  if (tier === 'standard') {
    return 1;
  }
  return 2;
}

function compareCost(left: RankedCandidate, right: RankedCandidate): number {
  if (!costsTied(left.estimatedCost, right.estimatedCost)) {
    return left.estimatedCost - right.estimatedCost;
  }
  const health = healthRank(left.model.health) - healthRank(right.model.health);
  if (health !== 0) {
    return health;
  }
  const latency = latencyRank(left.model.latencyClass) - latencyRank(right.model.latencyClass);
  if (latency !== 0) {
    return latency;
  }
  const tier = tierRank(left.model.tier) - tierRank(right.model.tier);
  if (tier !== 0) {
    return tier;
  }
  return left.model.id.localeCompare(right.model.id);
}

function relativeCostScore(cost: number, cheapest: number): number {
  if (cost <= 0 || cheapest <= 0) {
    return cost <= cheapest ? 1 : 0;
  }
  return cheapest / cost;
}

export function selectRoute(input: {
  profile: RequestProfile;
  models: RoutingModel[];
  strategy: RoutingStrategy;
  constraints: RoutingConstraints;
  /** Models outside this list are ineligible. runtimeProvider remains as a one-provider alias for older callers. */
  eligibleProviders?: string[];
  runtimeProvider?: string;
  modelAllowed: (provider: string, modelName: string) => boolean;
  maxRequestCostUsd: number | null;
  remainingBudgetUsd: number | null;
  baseline: RoutingModel | null;
}): RouteSelection {
  const rejected: RejectedCandidate[] = [];
  const viable: RankedCandidate[] = [];
  let sawBudgetReject = false;
  let sawContextReject = false;
  let sawPricingReject = false;
  const eligible = input.eligibleProviders ?? (input.runtimeProvider ? [input.runtimeProvider] : []);
  const preferred = new Set(input.constraints.preferredProviders ?? []);

  for (const model of input.models) {
    const reject = (code: string) => {
      rejected.push({ modelName: model.modelName, provider: model.provider, code });
    };
    if (eligible.length > 0 && !eligible.includes(model.provider)) {
      reject('provider_not_eligible');
      continue;
    }
    if ((input.constraints.prohibitedProviders ?? []).includes(model.provider)) {
      reject('provider_prohibited');
      continue;
    }
    if (input.constraints.allowedProviders.length > 0 && !input.constraints.allowedProviders.includes(model.provider)) {
      reject('provider_not_approved');
      continue;
    }
    if (input.constraints.prohibitedTiers.includes(model.tier)) {
      reject('tier_prohibited');
      continue;
    }
    if (!input.modelAllowed(model.provider, model.modelName)) {
      reject('model_not_allowed');
      continue;
    }
    if (model.health === 'unavailable') {
      reject('provider_unavailable');
      continue;
    }
    const missing = capabilityMissing(model, input.profile.requiredCapabilities);
    if (missing) {
      reject(missing);
      continue;
    }
    if (input.profile.usesTools && !model.supportsTools) {
      reject('capability_missing');
      continue;
    }
    if (input.profile.requiresVision && !model.supportsVision) {
      reject('capability_missing');
      continue;
    }
    const capped = capEstimateForModel(
      {
        estimatedInputTokens: input.profile.estimatedInputTokens,
        requestSize: input.profile.requestSize,
        estimatedOutputTokens: input.profile.estimatedOutputTokens,
      },
      model.maxOutputTokens,
    );
    const minimum = input.constraints.minimumContextWindow ?? 0;
    if (model.contextWindow < capped.estimatedTotalContextTokens || model.contextWindow < minimum) {
      sawContextReject = true;
      reject('context_too_large');
      continue;
    }
    // Gemini 2.5 Pro catalogue prices are the <=200k tier only. Refuse larger prompts until tiered pricing exists.
    if (
      model.provider === 'google' &&
      model.modelName === 'gemini-2.5-pro' &&
      capped.estimatedInputTokens > 200_000
    ) {
      sawPricingReject = true;
      reject('pricing_tier_unsupported');
      continue;
    }
    const estimatedCost = estimateModelCost(model, capped.estimatedInputTokens, capped.estimatedOutputTokens);
    if (estimatedCost === null) {
      sawPricingReject = true;
      reject('pricing_unknown');
      continue;
    }
    if (input.maxRequestCostUsd !== null && estimatedCost > input.maxRequestCostUsd) {
      reject('over_request_cost');
      continue;
    }
    if (input.remainingBudgetUsd !== null && estimatedCost > input.remainingBudgetUsd) {
      sawBudgetReject = true;
      reject('over_budget');
      continue;
    }
    viable.push({ model, estimatedCost, score: 0 });
  }

  if (input.strategy === 'cost') {
    viable.sort(compareCost);
    for (const candidate of viable) {
      candidate.score = candidate.estimatedCost;
    }
  } else {
    const cheapest = viable.reduce((min, candidate) => Math.min(min, candidate.estimatedCost), Number.POSITIVE_INFINITY);
    const weight = weights[input.strategy];
    for (const candidate of viable) {
      const health = candidate.model.health === 'degraded' ? 0.7 : 1;
      const score =
        (weight.cost * relativeCostScore(candidate.estimatedCost, cheapest) +
          weight.quality * tierQuality[candidate.model.tier] +
          weight.latency * latencyScore[candidate.model.latencyClass]) *
        health;
      candidate.score = Number(score.toFixed(6));
    }
    viable.sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (Math.abs(scoreDelta) > 0.02) {
        return scoreDelta;
      }
      const preference = Number(preferred.has(right.model.provider)) - Number(preferred.has(left.model.provider));
      return preference || scoreDelta || compareCost(left, right);
    });
  }

  const selected = viable[0] ?? null;
  const baselineCapped =
    input.baseline === null
      ? null
      : capEstimateForModel(
          {
            estimatedInputTokens: input.profile.estimatedInputTokens,
            requestSize: input.profile.requestSize,
            estimatedOutputTokens: input.profile.estimatedOutputTokens,
          },
          input.baseline.maxOutputTokens,
        );
  const baselineCost =
    input.baseline === null || baselineCapped === null
      ? null
      : estimateModelCost(input.baseline, baselineCapped.estimatedInputTokens, baselineCapped.estimatedOutputTokens);
  const estimatedSavings =
    selected && baselineCost !== null ? Number((baselineCost - selected.estimatedCost).toFixed(8)) : null;
  let failure: RouteSelection['failure'] = null;
  if (!selected) {
    if (sawBudgetReject && rejected.every((item) => item.code === 'over_budget' || item.code === 'provider_not_eligible' || item.code === 'provider_not_runtime')) {
      failure = 'budget_exceeded';
    } else if (
      sawBudgetReject &&
      !rejected.some((item) => item.code !== 'over_budget' && item.code !== 'provider_not_eligible' && item.code !== 'provider_not_runtime' && item.code !== 'tier_prohibited' && item.code !== 'provider_prohibited')
    ) {
      failure = 'budget_exceeded';
    } else if (sawContextReject && viable.length === 0 && !sawBudgetReject) {
      failure = rejected.some((item) => item.code !== 'context_too_large' && item.code !== 'provider_not_eligible' && item.code !== 'provider_not_runtime')
        ? 'no_compatible_model'
        : 'context_too_large';
    } else if (sawPricingReject && rejected.every((item) => item.code === 'pricing_unknown' || item.code === 'provider_not_eligible' || item.code === 'provider_not_runtime')) {
      failure = 'pricing_unknown';
    } else {
      failure = 'no_compatible_model';
    }
  }
  return {
    selected,
    ranked: viable,
    rejected,
    estimatedBaselineCost: baselineCost,
    estimatedSavings,
    failure,
  };
}

export function explainSelection(input: {
  selected: RankedCandidate;
  ranked: RankedCandidate[];
  strategy: RoutingStrategy;
  profile: RequestProfile;
  baselineConfigured: boolean;
  savingsAvailable: boolean;
}): RouteExplanation {
  const others = input.ranked.filter((candidate) => candidate.model.id !== input.selected.model.id);
  const sortedByCost = [...input.ranked].sort((left, right) => left.estimatedCost - right.estimatedCost);
  const cheapest = sortedByCost[0];
  const nextCheapest = sortedByCost.find((candidate) => candidate.model.id !== input.selected.model.id) ?? null;
  const lowestCost = Boolean(cheapest && costsTied(input.selected.estimatedCost, cheapest.estimatedCost));
  const sentences: string[] = [];
  if (input.strategy === 'cost' && lowestCost) {
    sentences.push('Lowest estimated cost among qualifying models.');
  } else if (input.strategy === 'balanced') {
    sentences.push('Highest balanced route score across cost, capability tier, provider health and latency.');
  } else if (input.strategy === 'quality') {
    sentences.push('Highest quality-priority score among qualifying models.');
  } else if (input.strategy === 'latency') {
    sentences.push('Highest latency-priority score among qualifying models.');
  }
  sentences.push(`Selected estimated cost ${input.selected.estimatedCost}.`);
  if (nextCheapest && input.strategy === 'cost') {
    sentences.push(`Next qualifying estimated cost ${nextCheapest.estimatedCost}.`);
  }
  sentences.push(`Qualifying models: ${input.ranked.length}.`);
  sentences.push(
    input.selected.model.health === 'healthy' ? 'Provider health: healthy.' : 'Provider health: degraded.',
  );
  sentences.push(`Required capabilities: ${input.profile.requiredCapabilities.join(', ')}.`);
  sentences.push(
    `Request size: ${input.profile.requestSize}. This is message length, not a judgement of task difficulty.`,
  );
  if (!input.baselineConfigured) {
    sentences.push('Baseline not configured.');
  } else if (!input.savingsAvailable) {
    sentences.push('Estimated optimisation benefit unavailable because pricing data requires verification.');
  }
  if (others.length === 0 && input.strategy === 'cost' && !lowestCost) {
    sentences.push('No cheaper qualifying model was available.');
  }
  return {
    sentences,
    selectedCost: input.selected.estimatedCost,
    nextCheapestCost: nextCheapest?.estimatedCost ?? null,
    qualifyingCount: input.ranked.length,
    health: input.selected.model.health,
    requiredCapabilities: input.profile.requiredCapabilities,
    requestSize: input.profile.requestSize,
    lowestCost,
  };
}
