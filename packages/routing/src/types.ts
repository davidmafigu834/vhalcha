export const routingModes = ['fixed', 'optimised'] as const;
export const routingStrategies = ['cost', 'balanced', 'quality', 'latency'] as const;
export const modelTiers = ['economy', 'standard', 'premium'] as const;
export const requestSizes = ['small', 'medium', 'large'] as const;
/** @deprecated Stored values are request sizes. The column name remains complexity. */
export const complexityLevels = requestSizes;
export const routeRiskLevels = ['low', 'medium', 'high'] as const;
export const providerHealthStates = ['healthy', 'degraded', 'unavailable'] as const;

export type RoutingMode = (typeof routingModes)[number];
export type RoutingStrategy = (typeof routingStrategies)[number];
export type ModelTier = (typeof modelTiers)[number];
export type RequestSize = (typeof requestSizes)[number];
export type ComplexityLevel = RequestSize;
export type RouteRiskLevel = (typeof routeRiskLevels)[number];
export type ProviderHealthState = (typeof providerHealthStates)[number];

export interface RequestProfile {
  taskType: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  requestSize: RequestSize;
  /**
   * Same value as requestSize. Persisted in routing_decisions.complexity.
   * The column name is historical. It is not semantic task difficulty.
   */
  complexity: RequestSize;
  risk: RouteRiskLevel;
  requiredCapabilities: string[];
  hasKnowledgeContext: boolean;
  /** Always false. The public request schema cannot express tool calls. */
  usesTools: boolean;
  requiresStructuredOutput: boolean;
  /** Always false. The public request schema cannot express images. */
  requiresVision: boolean;
  expectedLatencyClass: 'fast' | 'normal' | 'slow';
}

export interface RoutingModel {
  id: string;
  provider: string;
  modelName: string;
  displayName: string;
  tier: ModelTier;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: string[];
  reasoningLevel: 'low' | 'medium' | 'high';
  latencyClass: 'fast' | 'normal' | 'slow';
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  health: ProviderHealthState;
  priceVerifiedAt?: string | null;
}

export interface RoutingConstraints {
  prohibitedTiers: ModelTier[];
  allowedProviders: string[];
  prohibitedProviders?: string[];
  /** Soft preference for non-cost strategies when scores are close. Cost ignores this list. */
  preferredProviders?: string[];
  minimumContextWindow: number | null;
}

export interface RejectedCandidate {
  modelName: string;
  provider: string;
  code: string;
}

export interface RankedCandidate {
  model: RoutingModel;
  estimatedCost: number;
  score: number;
}

export interface RouteExplanation {
  sentences: string[];
  selectedCost: number;
  nextCheapestCost: number | null;
  qualifyingCount: number;
  health: ProviderHealthState;
  requiredCapabilities: string[];
  requestSize: RequestSize;
  lowestCost: boolean;
}

export interface RouteSelection {
  selected: RankedCandidate | null;
  ranked: RankedCandidate[];
  rejected: RejectedCandidate[];
  estimatedBaselineCost: number | null;
  estimatedSavings: number | null;
  failure: 'no_compatible_model' | 'budget_exceeded' | 'context_too_large' | 'pricing_unknown' | null;
}

export interface RequestClassifier {
  classify(input: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    hasKnowledgeContext: boolean;
    systemRisk: 'low' | 'medium' | 'high' | 'critical';
  }): RequestProfile;
}
