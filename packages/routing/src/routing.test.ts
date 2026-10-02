import { describe, expect, it } from 'vitest';
import { HeuristicRequestClassifier } from './classify';
import { effectiveHealth, healthAfterFailure, healthAfterSuccess } from './health';
import { explainSelection, selectRoute } from './select';
import type { RequestProfile, RoutingModel } from './types';

function model(overrides: Partial<RoutingModel> & Pick<RoutingModel, 'modelName' | 'tier' | 'contextWindow' | 'capabilities'>): RoutingModel {
  return {
    id: overrides.id ?? overrides.modelName,
    provider: 'mock',
    displayName: overrides.modelName,
    inputUsdPerMillion: overrides.tier === 'premium' ? 2 : overrides.tier === 'standard' ? 0.4 : 0.05,
    outputUsdPerMillion: overrides.tier === 'premium' ? 8 : overrides.tier === 'standard' ? 1.6 : 0.2,
    maxOutputTokens: 4000,
    reasoningLevel: overrides.tier === 'premium' ? 'high' : 'low',
    latencyClass: overrides.tier === 'economy' ? 'fast' : overrides.tier === 'premium' ? 'slow' : 'normal',
    supportsTools: false,
    supportsVision: false,
    supportsStructuredOutput: overrides.capabilities.includes('structured_output'),
    supportsStreaming: true,
    health: 'healthy',
    ...overrides,
  };
}

const economy = model({
  modelName: 'economy-model',
  tier: 'economy',
  contextWindow: 1000,
  capabilities: ['chat', 'classification'],
});
const standard = model({
  modelName: 'standard-model',
  tier: 'standard',
  contextWindow: 32000,
  capabilities: ['chat', 'classification', 'structured_output'],
});
const premium = model({
  modelName: 'premium-model',
  tier: 'premium',
  contextWindow: 200000,
  capabilities: ['chat', 'classification', 'reasoning', 'long_context', 'structured_output'],
  inputUsdPerMillion: 2,
  outputUsdPerMillion: 8,
});

const classifier = new HeuristicRequestClassifier();

function profile(overrides: Partial<RequestProfile> = {}): RequestProfile {
  return {
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
    ...overrides,
  };
}

function route(models: RoutingModel[], strategy: 'cost' | 'balanced' | 'quality' | 'latency', request = profile(), remaining: number | null = null) {
  return selectRoute({
    profile: request,
    models,
    strategy,
    constraints: { prohibitedTiers: [], allowedProviders: [], minimumContextWindow: null },
    runtimeProvider: 'mock',
    modelAllowed: () => true,
    maxRequestCostUsd: null,
    remainingBudgetUsd: remaining,
    baseline: null,
  });
}

describe('routing engine', () => {
  it('classifies a short request by size, not semantic difficulty', () => {
    const classified = classifier.classify({
      messages: [{ role: 'user', content: 'Classify this support message.' }],
      hasKnowledgeContext: false,
      systemRisk: 'low',
    });
    expect(classified.requestSize).toBe('small');
    expect(classified.complexity).toBe('small');
    expect(classified.taskType).toBe('classification');
    expect(classified.risk).toBe('low');
  });

  it('does not treat a short high-stakes sentence as a hard task', () => {
    const classified = classifier.classify({
      messages: [
        {
          role: 'user',
          content: 'Analyse this acquisition agreement and identify financial, legal and operational risks.',
        },
      ],
      hasKnowledgeContext: false,
      systemRisk: 'low',
    });
    expect(classified.requestSize).toBe('small');
    expect(classified.requiredCapabilities).toEqual(['chat']);
    expect(classified.usesTools).toBe(false);
    expect(classified.requiresVision).toBe(false);
  });

  it('selects the economy model for a small cost route', () => {
    const classified = classifier.classify({
      messages: [{ role: 'user', content: 'Classify this support message.' }],
      hasKnowledgeContext: false,
      systemRisk: 'low',
    });
    const decision = selectRoute({
      profile: classified,
      models: [premium, standard, economy],
      strategy: 'cost',
      constraints: { prohibitedTiers: [], allowedProviders: [], minimumContextWindow: null },
      runtimeProvider: 'mock',
      modelAllowed: () => true,
      maxRequestCostUsd: null,
      remainingBudgetUsd: null,
      baseline: premium,
    });
    expect(decision.selected?.model.modelName).toBe('economy-model');
    expect(decision.estimatedBaselineCost).toBeGreaterThan(decision.selected?.estimatedCost ?? 0);
    expect(decision.estimatedSavings).toBeGreaterThan(0);
    const explanation = explainSelection({
      selected: decision.selected!,
      ranked: decision.ranked,
      strategy: 'cost',
      profile: classified,
      baselineConfigured: true,
      savingsAvailable: true,
    });
    expect(explanation.lowestCost).toBe(true);
    expect(explanation.sentences.some((sentence) => sentence.includes('Lowest estimated cost'))).toBe(true);
  });

  it('selects the cheaper capable model when estimates are $0.0162 and $0.27', () => {
    const cheap = model({
      id: 'economy',
      modelName: 'economy',
      tier: 'economy',
      contextWindow: 200000,
      capabilities: ['chat', 'reasoning', 'long_context'],
      latencyClass: 'normal',
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.6,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsVision: true,
    });
    const expensive = model({
      id: 'premium',
      modelName: 'premium',
      tier: 'premium',
      contextWindow: 200000,
      capabilities: ['chat', 'reasoning', 'long_context'],
      latencyClass: 'normal',
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 10,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsVision: true,
    });
    const request = profile({
      estimatedInputTokens: 100000,
      estimatedOutputTokens: 2000,
      requestSize: 'large',
      complexity: 'large',
      requiredCapabilities: ['chat'],
    });
    const decision = route([expensive, cheap], 'cost', request);
    expect(decision.selected?.estimatedCost).toBeCloseTo(0.0162, 8);
    expect(decision.ranked[1]?.estimatedCost).toBeCloseTo(0.27, 8);
    expect(decision.selected?.model.modelName).toBe('economy');
    const explanation = explainSelection({
      selected: decision.selected!,
      ranked: decision.ranked,
      strategy: 'cost',
      profile: request,
      baselineConfigured: false,
      savingsAvailable: true,
    });
    expect(explanation.lowestCost).toBe(true);
    expect(explanation.sentences[0]).toBe('Lowest estimated cost among qualifying models.');
    expect(explanation.sentences.join(' ')).not.toContain('quality');
  });

  it.each([
    [0.00001, 0.0001],
    [0.01, 0.2],
    [1, 15],
    [100, 500],
  ])('cost strategy prefers $%s over $%s', (low, high) => {
    const cheap = model({
      id: 'cheap',
      modelName: 'cheap',
      tier: 'economy',
      contextWindow: 2_000_000,
      capabilities: ['chat'],
      inputUsdPerMillion: low,
      outputUsdPerMillion: 0,
      maxOutputTokens: 1,
    });
    const costly = model({
      id: 'costly',
      modelName: 'costly',
      tier: 'premium',
      contextWindow: 2_000_000,
      capabilities: ['chat'],
      latencyClass: 'fast',
      inputUsdPerMillion: high,
      outputUsdPerMillion: 0,
      maxOutputTokens: 1,
    });
    const request = profile({ estimatedInputTokens: 1_000_000, estimatedOutputTokens: 0, requestSize: 'large', complexity: 'large' });
    const decision = route([costly, cheap], 'cost', request);
    expect(decision.selected?.model.modelName).toBe('cheap');
    expect(decision.selected?.estimatedCost).toBeCloseTo(low, 8);
  });

  it('does not describe a quality selection as the cheapest route', () => {
    const decision = route([economy, premium], 'quality');
    expect(decision.selected?.model.modelName).toBe('premium-model');
    const explanation = explainSelection({
      selected: decision.selected!,
      ranked: decision.ranked,
      strategy: 'quality',
      profile: profile(),
      baselineConfigured: false,
      savingsAvailable: true,
    });
    expect(explanation.sentences.join(' ')).not.toMatch(/[Ll]owest estimated cost/);
    expect(explanation.sentences[0]).toContain('quality-priority');
  });

  it('describes a latency selection as a latency choice', () => {
    const decision = route([economy, premium], 'latency');
    expect(decision.selected?.model.modelName).toBe('economy-model');
    const explanation = explainSelection({
      selected: decision.selected!,
      ranked: decision.ranked,
      strategy: 'latency',
      profile: profile(),
      baselineConfigured: true,
      savingsAvailable: false,
    });
    expect(explanation.sentences[0]).toContain('latency-priority');
    expect(explanation.sentences.join(' ')).toContain('pricing data requires verification');
  });

  it('drops the economy model when the prompt exceeds its context window', () => {
    const classified = classifier.classify({
      messages: [{ role: 'user', content: 'A'.repeat(5000) }],
      hasKnowledgeContext: true,
      systemRisk: 'medium',
    });
    const decision = selectRoute({
      profile: classified,
      models: [economy, standard, premium],
      strategy: 'balanced',
      constraints: { prohibitedTiers: [], allowedProviders: [], minimumContextWindow: null },
      runtimeProvider: 'mock',
      modelAllowed: () => true,
      maxRequestCostUsd: null,
      remainingBudgetUsd: null,
      baseline: premium,
    });
    expect(decision.rejected.some((item) => item.modelName === 'economy-model' && item.code === 'context_too_large')).toBe(true);
    expect(decision.selected?.model.modelName).not.toBe('economy-model');
  });

  it('removes a candidate that exceeds the remaining budget', () => {
    const classified = classifier.classify({
      messages: [{ role: 'user', content: 'Classify this support message.' }],
      hasKnowledgeContext: false,
      systemRisk: 'low',
    });
    const decision = selectRoute({
      profile: classified,
      models: [economy, premium],
      strategy: 'quality',
      constraints: { prohibitedTiers: [], allowedProviders: [], minimumContextWindow: null },
      runtimeProvider: 'mock',
      modelAllowed: () => true,
      maxRequestCostUsd: null,
      remainingBudgetUsd: 0.0002,
      baseline: null,
    });
    expect(decision.selected?.model.modelName).toBe('economy-model');
    expect(decision.rejected.some((item) => item.modelName === 'premium-model' && item.code === 'over_budget')).toBe(true);
    expect(decision.estimatedSavings).toBeNull();
  });

  it('rejects a model the access rule denies', () => {
    const classified = classifier.classify({
      messages: [{ role: 'user', content: 'Hello' }],
      hasKnowledgeContext: false,
      systemRisk: 'low',
    });
    const decision = selectRoute({
      profile: classified,
      models: [economy, standard],
      strategy: 'cost',
      constraints: { prohibitedTiers: ['economy'], allowedProviders: ['mock'], minimumContextWindow: null },
      runtimeProvider: 'mock',
      modelAllowed: (_provider, name) => name !== 'economy-model',
      maxRequestCostUsd: null,
      remainingBudgetUsd: null,
      baseline: null,
    });
    expect(decision.selected?.model.modelName).toBe('standard-model');
    expect(decision.rejected.some((item) => item.code === 'tier_prohibited')).toBe(true);
  });

  it('opens the circuit after repeated failures and recovers after cooldown', () => {
    const now = new Date('2026-09-29T00:00:00.000Z');
    const opened = healthAfterFailure(healthAfterFailure(healthAfterFailure(null, now), now), now);
    expect(opened.status).toBe('unavailable');
    expect(effectiveHealth(opened, new Date(now.getTime() + 1000))).toBe('unavailable');
    expect(effectiveHealth(opened, new Date(now.getTime() + 61_000))).toBe('degraded');
    expect(healthAfterSuccess().status).toBe('healthy');
  });

  it('selects the cheapest model across providers in Cost strategy', () => {
    const openai = model({
      id: 'oai',
      provider: 'openai',
      modelName: 'openai-economy',
      tier: 'economy',
      contextWindow: 128000,
      capabilities: ['chat'],
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 8,
    });
    const anthropic = model({
      id: 'ant',
      provider: 'anthropic',
      modelName: 'anthropic-standard',
      tier: 'standard',
      contextWindow: 200000,
      capabilities: ['chat'],
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    });
    const gemini = model({
      id: 'gem',
      provider: 'google',
      modelName: 'gemini-economy',
      tier: 'economy',
      contextWindow: 1_000_000,
      capabilities: ['chat'],
      inputUsdPerMillion: 0.3,
      outputUsdPerMillion: 2.5,
    });
    const decision = selectRoute({
      profile: profile(),
      models: [openai, anthropic, gemini],
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
    expect(decision.selected?.model.modelName).toBe('gemini-economy');
    expect(decision.selected?.model.provider).toBe('google');
    expect(decision.selected!.estimatedCost).toBeLessThan(
      decision.ranked.find((item) => item.model.provider === 'openai')!.estimatedCost,
    );
  });

  it('excludes a denied provider from candidates', () => {
    const openai = model({
      id: 'oai',
      provider: 'openai',
      modelName: 'openai-economy',
      tier: 'economy',
      contextWindow: 128000,
      capabilities: ['chat'],
      inputUsdPerMillion: 0.4,
      outputUsdPerMillion: 1.6,
    });
    const gemini = model({
      id: 'gem',
      provider: 'google',
      modelName: 'gemini-economy',
      tier: 'economy',
      contextWindow: 1_000_000,
      capabilities: ['chat'],
      inputUsdPerMillion: 0.3,
      outputUsdPerMillion: 2.5,
    });
    const decision = selectRoute({
      profile: profile(),
      models: [openai, gemini],
      strategy: 'cost',
      constraints: {
        prohibitedTiers: [],
        allowedProviders: ['openai', 'google'],
        prohibitedProviders: ['google'],
        minimumContextWindow: null,
      },
      eligibleProviders: ['openai', 'google'],
      modelAllowed: () => true,
      maxRequestCostUsd: null,
      remainingBudgetUsd: null,
      baseline: null,
    });
    expect(decision.selected?.model.provider).toBe('openai');
    expect(decision.rejected.some((item) => item.provider === 'google' && item.code === 'provider_prohibited')).toBe(true);
  });

  it('uses preferred providers only as a soft factor outside Cost', () => {
    const openai = model({
      id: 'oai',
      provider: 'openai',
      modelName: 'openai-standard',
      tier: 'standard',
      contextWindow: 128000,
      capabilities: ['chat'],
      inputUsdPerMillion: 0.4,
      outputUsdPerMillion: 1.6,
      latencyClass: 'normal',
    });
    const anthropic = model({
      id: 'ant',
      provider: 'anthropic',
      modelName: 'anthropic-standard',
      tier: 'standard',
      contextWindow: 200000,
      capabilities: ['chat'],
      inputUsdPerMillion: 0.4,
      outputUsdPerMillion: 1.6,
      latencyClass: 'normal',
    });
    const decision = selectRoute({
      profile: profile(),
      models: [openai, anthropic],
      strategy: 'balanced',
      constraints: {
        prohibitedTiers: [],
        allowedProviders: ['openai', 'anthropic'],
        preferredProviders: ['anthropic'],
        minimumContextWindow: null,
      },
      eligibleProviders: ['openai', 'anthropic'],
      modelAllowed: () => true,
      maxRequestCostUsd: null,
      remainingBudgetUsd: null,
      baseline: null,
    });
    expect(decision.selected?.model.provider).toBe('anthropic');
  });

  it('hard-gates Gemini 2.5 Pro above 200k estimated input tokens', () => {
    const pro = model({
      id: 'gem-pro',
      provider: 'google',
      modelName: 'gemini-2.5-pro',
      tier: 'premium',
      contextWindow: 1_048_576,
      capabilities: ['chat'],
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
    });
    const flash = model({
      id: 'gem-flash',
      provider: 'google',
      modelName: 'gemini-2.5-flash',
      tier: 'economy',
      contextWindow: 1_048_576,
      capabilities: ['chat'],
      inputUsdPerMillion: 0.3,
      outputUsdPerMillion: 2.5,
    });
    const decision = selectRoute({
      profile: profile({ estimatedInputTokens: 250_000, requestSize: 'large', complexity: 'large' }),
      models: [pro, flash],
      strategy: 'cost',
      constraints: { prohibitedTiers: [], allowedProviders: ['google'], minimumContextWindow: null },
      eligibleProviders: ['google'],
      modelAllowed: () => true,
      maxRequestCostUsd: null,
      remainingBudgetUsd: null,
      baseline: null,
    });
    expect(decision.rejected.some((item) => item.modelName === 'gemini-2.5-pro' && item.code === 'pricing_tier_unsupported')).toBe(
      true,
    );
    expect(decision.selected?.model.modelName).toBe('gemini-2.5-flash');
  });
});
