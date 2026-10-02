import { calculateTokenCost } from '@vhalcha/providers';
import type { RoutingModel } from './types';

export function estimateModelCost(
  model: Pick<RoutingModel, 'inputUsdPerMillion' | 'outputUsdPerMillion'>,
  inputTokens: number,
  outputTokens: number,
): number | null {
  return calculateTokenCost({
    price: { inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion },
    inputTokens,
    outputTokens,
  }).costUsd;
}
