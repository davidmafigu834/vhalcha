import type { ChatCompletionRequest } from '@vhalcha/types';

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'mock';

export type ProviderErrorCode =
  | 'provider_authentication_failed'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_invalid_request'
  | 'provider_content_rejected'
  | 'provider_error';

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Present only when the provider reports a cached-input quantity. */
  cachedInputTokens?: number;
  /**
   * True when inputTokens already includes cachedInputTokens.
   * Anthropic reports uncached input separately, so this is false there.
   */
  inputIncludesCached?: boolean;
  reasoningTokens?: number;
}

export interface NormalizedProviderError {
  code: ProviderErrorCode;
  message: string;
  providerStatus: number | null;
}

export interface ProviderChatResult {
  responseBody: unknown;
  usage: NormalizedUsage | null;
  providerLatencyMs: number;
}

export interface ProviderStream {
  status: number;
  headers: Record<string, string>;
  chunks: AsyncIterable<Uint8Array>;
  usage: () => NormalizedUsage | null;
  timeToFirstTokenMs: () => number | null;
  providerLatencyMs: () => number;
}

export interface ProviderContext {
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ModelProvider {
  readonly id: ProviderId;
  chatCompletion(request: ChatCompletionRequest, context: ProviderContext): Promise<ProviderChatResult>;
  streamChatCompletion(request: ChatCompletionRequest, context: ProviderContext): Promise<ProviderStream>;
  normalizeUsage(raw: unknown): NormalizedUsage | null;
  normalizeError(error: unknown, status?: number): NormalizedProviderError;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
}

export function normalizeOpenAiUsage(raw: unknown): NormalizedUsage | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const usage = (asRecord(record.usage) ?? record) as OpenAiUsage;
  if (
    typeof usage.prompt_tokens !== 'number' ||
    typeof usage.completion_tokens !== 'number' ||
    typeof usage.total_tokens !== 'number'
  ) {
    return null;
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

export function classifyProviderStatus(status: number | null, error?: unknown): NormalizedProviderError {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return {
      code: 'provider_timeout',
      message: 'The model provider timed out.',
      providerStatus: status,
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: 'provider_authentication_failed',
      message: 'Authentication rejected.',
      providerStatus: status,
    };
  }
  if (status === 429) {
    return {
      code: 'provider_rate_limited',
      message: 'The model provider rate limit was reached.',
      providerStatus: status,
    };
  }
  if (status === 400) {
    return {
      code: 'provider_invalid_request',
      message: 'The model provider rejected the request.',
      providerStatus: status,
    };
  }
  if (status === null || status >= 500) {
    return {
      code: 'provider_unavailable',
      message: 'The model provider is unavailable.',
      providerStatus: status,
    };
  }
  return {
    code: 'provider_error',
    message: 'The model provider returned an error.',
    providerStatus: status,
  };
}

export function normalizeOpenAiError(error: unknown, status?: number): NormalizedProviderError {
  return classifyProviderStatus(status ?? null, error);
}

function providerBody(request: ChatCompletionRequest, stream: boolean) {
  return {
    model: request.model,
    messages: request.messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

export class OpenAIProvider implements ModelProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  private requestSignal(context: ProviderContext): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    if (context.signal) {
      return AbortSignal.any([context.signal, timeout]);
    }
    return timeout;
  }

  normalizeUsage(raw: unknown): NormalizedUsage | null {
    return normalizeOpenAiUsage(raw);
  }

  normalizeError(error: unknown, status?: number): NormalizedProviderError {
    return normalizeOpenAiError(error, status);
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    context: ProviderContext,
  ): Promise<ProviderChatResult> {
    const started = Date.now();
    const fetchImpl = context.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(providerBody(request, false)),
        signal: this.requestSignal(context),
      });
    } catch (error) {
      throw Object.assign(new Error('provider_unavailable'), {
        normalized: this.normalizeError(error),
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error('provider_error'), {
        normalized: this.normalizeError(new Error('provider'), response.status),
      });
    }
    const responseBody = JSON.parse(text) as unknown;
    return {
      responseBody,
      usage: this.normalizeUsage(responseBody),
      providerLatencyMs: Date.now() - started,
    };
  }

  async streamChatCompletion(
    request: ChatCompletionRequest,
    context: ProviderContext,
  ): Promise<ProviderStream> {
    const started = Date.now();
    const fetchImpl = context.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(providerBody(request, true)),
        signal: this.requestSignal(context),
      });
    } catch (error) {
      throw Object.assign(new Error('provider_unavailable'), {
        normalized: this.normalizeError(error),
      });
    }
    if (!response.ok || !response.body) {
      throw Object.assign(new Error('provider_error'), {
        normalized: this.normalizeError(new Error('provider'), response.status),
      });
    }
    let usage: NormalizedUsage | null = null;
    let firstTokenAt: number | null = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const consume = (bytes: Uint8Array) => {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') {
          continue;
        }
        try {
          const parsed = JSON.parse(data) as {
            usage?: unknown;
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const normalized = normalizeOpenAiUsage({ usage: parsed.usage });
          if (normalized) {
            usage = normalized;
          }
          if (parsed.choices?.[0]?.delta?.content && firstTokenAt === null) {
            firstTokenAt = Date.now();
          }
        } catch {
          // Incomplete SSE JSON is ignored until a later chunk completes a line.
        }
      }
    };
    const iterator = (async function* chunks() {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          return;
        }
        yield next.value;
        consume(next.value);
      }
    })();
    return {
      status: response.status,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      chunks: iterator,
      usage: () => usage,
      timeToFirstTokenMs: () => (firstTokenAt === null ? null : firstTokenAt - started),
      providerLatencyMs: () => Date.now() - started,
    };
  }
}

export function createModelProvider(provider: 'openai'): ModelProvider {
  if (provider === 'openai') {
    return new OpenAIProvider();
  }
  throw new Error(`Provider ${provider} is not implemented.`);
}
