import { describe, expect, it } from 'vitest';
import { calculateModelCost, calculateTokenCost } from './index';

describe('calculateTokenCost', () => {
  it('prices tokens from the supplied catalogue rate', () => {
    const result = calculateTokenCost({
      price: { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.pricingKnown).toBe(true);
    expect(result.costUsd).toBe(2);
  });

  it('does not invent a price when the catalogue has no rate', () => {
    const result = calculateModelCost({
      inputTokens: 10,
      outputTokens: 10,
      price: null,
    });
    expect(result.costUsd).toBeNull();
    expect(result.pricingKnown).toBe(false);
  });
});
