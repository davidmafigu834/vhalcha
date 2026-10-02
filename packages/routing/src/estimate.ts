import type { RequestSize } from './types';

/**
 * One token estimate for routing, context checks, reservations, baselines, and savings.
 *
 * Input tokens are ceil(characters / 4), with a floor of 1 when any message has text.
 * Request size is that input length. It is not a judgement of task difficulty.
 *   small  < 400 input tokens
 *   medium < 2000 input tokens
 *   large  >= 2000 input tokens
 * Output tokens are the client max_tokens when present, otherwise 256 / 800 / 2000
 * for small / medium / large. A model's own max output then caps that number.
 * Context and price both use input + capped output.
 */
export const OUTPUT_TOKENS_BY_SIZE = { small: 256, medium: 800, large: 2000 } as const;

export const COST_TIE_TOLERANCE = 1e-8;

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function requestSizeForInputTokens(inputTokens: number): RequestSize {
  if (inputTokens >= 2000) {
    return 'large';
  }
  if (inputTokens >= 400) {
    return 'medium';
  }
  return 'small';
}

export interface RequestTokenEstimate {
  estimatedInputTokens: number;
  requestSize: RequestSize;
  /** Output assumption before a model cap. */
  estimatedOutputTokens: number;
}

export function estimateRequestTokens(
  messages: readonly { content: string }[],
  maxTokens?: number,
): RequestTokenEstimate {
  const estimatedInputTokens = messages.reduce((sum, message) => sum + estimateTextTokens(message.content), 0);
  const requestSize = requestSizeForInputTokens(estimatedInputTokens);
  const estimatedOutputTokens = maxTokens ?? OUTPUT_TOKENS_BY_SIZE[requestSize];
  return {
    estimatedInputTokens: Math.max(estimatedInputTokens, messages.some((message) => message.content.trim()) ? 1 : 0),
    requestSize,
    estimatedOutputTokens,
  };
}

export interface ModelTokenEstimate extends RequestTokenEstimate {
  effectiveMaxOutputTokens: number;
  /** Tokens assumed for both the context-window check and the cost estimate. */
  estimatedTotalContextTokens: number;
}

export function capEstimateForModel(estimate: RequestTokenEstimate, maxOutputTokens: number): ModelTokenEstimate {
  const effectiveMaxOutputTokens = Math.max(0, Math.min(estimate.estimatedOutputTokens, maxOutputTokens));
  return {
    ...estimate,
    effectiveMaxOutputTokens,
    estimatedOutputTokens: effectiveMaxOutputTokens,
    estimatedTotalContextTokens: estimate.estimatedInputTokens + effectiveMaxOutputTokens,
  };
}
