export const knowledgeLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxPdfPages: 100,
  maxExtractedCharacters: 500_000,
  chunkTargetTokens: 600,
  chunkOverlapRatio: 0.15,
  embeddingDimensions: 1536,
  embeddingModel: 'text-embedding-3-small',
  embeddingProvider: 'openai',
  embeddingUsdPerMillionTokens: 0.02,
  embeddingBatchSize: 64,
  maxRetrievedTokens: 6_000,
  defaultTopK: 6,
  minTopK: 1,
  maxTopK: 20,
  defaultMinimumSimilarity: 0.2,
  maxIngestAttempts: 3,
} as const;

export const INSUFFICIENT_KNOWLEDGE_MESSAGE =
  "I couldn't verify that from the approved company knowledge available to this AI system.";

export function clampTopK(value: number | null | undefined): number {
  const numeric = Number.isFinite(value) ? Math.trunc(Number(value)) : knowledgeLimits.defaultTopK;
  return Math.min(knowledgeLimits.maxTopK, Math.max(knowledgeLimits.minTopK, numeric));
}
