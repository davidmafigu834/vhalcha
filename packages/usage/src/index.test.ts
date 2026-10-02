import { describe, expect, it } from 'vitest';
import { buildUsageDraft } from './index';

describe('buildUsageDraft', () => {
  it('marks a missing catalogue price instead of inventing a cost', () => {
    const draft = buildUsageDraft({
      provider: 'openai',
      model: 'not-a-real-model',
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      price: null,
    });
    expect(draft.costUsd).toBeNull();
    expect(draft.pricingKnown).toBe(false);
  });

  it('uses the supplied catalogue rate', () => {
    const draft = buildUsageDraft({
      provider: 'mock',
      model: 'economy-model',
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      price: { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.2 },
    });
    expect(draft.costUsd).toBe(0.05);
    expect(draft.pricingKnown).toBe(true);
  });
});