/**
 * Pure token-price arithmetic.
 * Runtime rates come from model_catalogue. This module does not keep a second price book.
 * Tests pass fixture rates. Operators update catalogue rows with `pnpm db:sync-prices`.
 */
export interface UnitPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number | null;
}

export function calculateTokenCost(input: {
  price: UnitPrice | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** When true, cached tokens are already inside inputTokens and are priced at the cache rate instead. */
  inputIncludesCached?: boolean;
}): { costUsd: number | null; pricingKnown: boolean } {
  const price = input.price;
  if (
    !price ||
    !Number.isFinite(price.inputUsdPerMillion) ||
    !Number.isFinite(price.outputUsdPerMillion) ||
    price.inputUsdPerMillion < 0 ||
    price.outputUsdPerMillion < 0
  ) {
    return { costUsd: null, pricingKnown: false };
  }
  const cached = Math.max(0, input.cachedInputTokens ?? 0);
  const cacheRate = price.cachedInputUsdPerMillion;
  const pricedCache =
    cached > 0 && cacheRate !== null && cacheRate !== undefined && Number.isFinite(cacheRate) && cacheRate >= 0;
  const freshInput = pricedCache && input.inputIncludesCached ? Math.max(0, input.inputTokens - cached) : input.inputTokens;
  const extraUncached = pricedCache || input.inputIncludesCached ? 0 : cached;
  const cost =
    ((freshInput + extraUncached) / 1_000_000) * price.inputUsdPerMillion +
    (pricedCache ? (cached / 1_000_000) * cacheRate : 0) +
    (input.outputTokens / 1_000_000) * price.outputUsdPerMillion;
  if (!Number.isFinite(cost) || cost < 0) {
    return { costUsd: null, pricingKnown: false };
  }
  return { costUsd: Number(cost.toFixed(8)), pricingKnown: true };
}

/** @deprecated Use calculateTokenCost with a catalogue price. Kept so callers pass rates explicitly. */
export function calculateModelCost(input: {
  inputTokens: number;
  outputTokens: number;
  price: UnitPrice | null;
}): { costUsd: number | null; pricingKnown: boolean; price: UnitPrice | null } {
  const priced = calculateTokenCost(input);
  return { ...priced, price: input.price };
}
