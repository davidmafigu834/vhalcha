import { calculateTokenCost, type UnitPrice } from '@vhalcha/providers';

export interface UsageDraft {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  pricingKnown: boolean;
}

export function buildUsageDraft(input: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  price: UnitPrice | null;
}): UsageDraft {
  const priced = calculateTokenCost({
    price: input.price,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  });
  return {
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    costUsd: priced.costUsd,
    pricingKnown: priced.pricingKnown,
  };
}
