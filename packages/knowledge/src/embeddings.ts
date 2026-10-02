import { createHash } from 'node:crypto';
import { knowledgeLimits } from './limits';

export interface EmbeddingProvider {
  readonly id: 'mock' | 'openai';
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export function deterministicEmbedding(text: string, dimensions = knowledgeLimits.embeddingDimensions): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  if (tokens.length === 0) {
    vector[0] = 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    id: 'mock',
    model: 'vhalcha-deterministic-v1',
    dimensions: knowledgeLimits.embeddingDimensions,
    async embedDocuments(texts: string[]) {
      return texts.map((text) => deterministicEmbedding(text));
    },
    async embedQuery(text: string) {
      return deterministicEmbedding(text);
    },
  };
}

export function createOpenAiEmbeddingProvider(apiKey: string): EmbeddingProvider {
  return {
    id: 'openai',
    model: knowledgeLimits.embeddingModel,
    dimensions: knowledgeLimits.embeddingDimensions,
    async embedDocuments(texts: string[]) {
      const vectors: number[][] = [];
      for (let index = 0; index < texts.length; index += knowledgeLimits.embeddingBatchSize) {
        const batch = texts.slice(index, index + knowledgeLimits.embeddingBatchSize);
        vectors.push(...(await requestEmbeddings(apiKey, batch)));
      }
      return vectors;
    },
    async embedQuery(text: string) {
      const [vector] = await requestEmbeddings(apiKey, [text]);
      if (!vector) {
        throw Object.assign(new Error('embedding_unavailable'), { retryable: true, code: 'embedding_unavailable' });
      }
      return vector;
    },
  };
}

async function requestEmbeddings(apiKey: string, input: string[]): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: knowledgeLimits.embeddingModel,
        input,
        dimensions: knowledgeLimits.embeddingDimensions,
      }),
    });
    if (!response.ok) {
      throw Object.assign(new Error('embedding_unavailable'), {
        retryable: response.status >= 500 || response.status === 429,
        code: 'embedding_unavailable',
      });
    }
    const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const ordered = [...(body.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    return ordered.map((item) => {
      if (!item.embedding || item.embedding.length !== knowledgeLimits.embeddingDimensions) {
        throw Object.assign(new Error('embedding_dimensions_mismatch'), {
          retryable: false,
          code: 'embedding_dimensions_mismatch',
        });
      }
      return item.embedding;
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw Object.assign(new Error('embedding_unavailable'), { retryable: true, code: 'embedding_unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

export function embeddingModeFromEnv(env: NodeJS.ProcessEnv = process.env): 'mock' | 'openai' {
  if (env.VHALCHA_EMBEDDING_MODE === 'mock' || env.VHALCHA_EMBEDDING_MODE === 'openai') {
    return env.VHALCHA_EMBEDDING_MODE;
  }
  if (env.VHALCHA_ENV !== 'production' && env.VHALCHA_PROVIDER_MODE === 'mock') {
    return 'mock';
  }
  return 'openai';
}

export function createEmbeddingProvider(input: { mode: 'mock' | 'openai'; apiKey?: string }): EmbeddingProvider {
  if (input.mode === 'mock') {
    if (process.env.VHALCHA_ENV === 'production') {
      throw new Error('Invalid environment configuration: VHALCHA_EMBEDDING_MODE');
    }
    return createMockEmbeddingProvider();
  }
  if (!input.apiKey) {
    throw Object.assign(new Error('embedding_unavailable'), { retryable: true, code: 'embedding_unavailable' });
  }
  return createOpenAiEmbeddingProvider(input.apiKey);
}

export function estimateEmbeddingCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * knowledgeLimits.embeddingUsdPerMillionTokens;
}

export function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}
