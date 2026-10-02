export { HeuristicRequestClassifier, estimateTokens } from './classify';
export {
  capEstimateForModel,
  COST_TIE_TOLERANCE,
  estimateRequestTokens,
  estimateTextTokens,
  OUTPUT_TOKENS_BY_SIZE,
  requestSizeForInputTokens,
  type ModelTokenEstimate,
  type RequestTokenEstimate,
} from './estimate';
export {
  effectiveHealth,
  healthAfterFailure,
  healthAfterSuccess,
  HEALTH_COOLDOWN_MS,
  HEALTH_FAILURES_TO_OPEN,
  type HealthSnapshot,
} from './health';
export { estimateModelCost } from './price';
export { explainSelection, selectRoute } from './select';
export type {
  ComplexityLevel,
  ModelTier,
  ProviderHealthState,
  RankedCandidate,
  RejectedCandidate,
  RequestClassifier,
  RequestProfile,
  RequestSize,
  RouteExplanation,
  RouteRiskLevel,
  RouteSelection,
  RoutingConstraints,
  RoutingMode,
  RoutingModel,
  RoutingStrategy,
} from './types';

/**
 * Future Guard checks sit between routing and the provider call, then again on the provider result.
 * This phase does not inspect prompts or answers. There is no Guard implementation here.
 */
export interface GuardExtensionPoint {
  readonly implemented: false;
}

export function pricingIsFresh(verifiedAt: Date | null, now: Date, maxAgeDays: number): boolean {
  if (!verifiedAt || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    return false;
  }
  const ageMs = now.getTime() - verifiedAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}
