import type { ChatCompletionRequest } from '@vhalcha/types';
import { splitChatMessages } from './messages';
import {
  classifyProviderStatus,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type ModelProvider,
  type NormalizedUsage,
  type ProviderChatResult,
  type ProviderContext,
  type ProviderStream,
} from './openai';
import { completionBody, sseDone, sseText, sseUsage } from './sse';

/**
 * Gemini generateContent API.
 * https://ai.google.dev/gemini-api/docs/text-generation
 * Credential check uses GET /v1beta/models, not a generation call.
 * Empty or blocked candidates are not treated as successful empty answers.
 */
export class GeminiProvider implements ModelProvider {
  readonly id = 'google' as const;

  constructor(
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    private readonly timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  private requestSignal(context: ProviderContext): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  }

  normalizeUsage(raw: unknown): NormalizedUsage | null {
    return normalizeGeminiUsage(raw);
  }

  normalizeError(error: unknown, status?: number) {
    return classifyProviderStatus(status ?? null, error);
  }

  async chatCompletion(request: ChatCompletionRequest, context: ProviderContext): Promise<ProviderChatResult> {
    const started = Date.now();
    const fetchImpl = context.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`, {
        method: 'POST',
        headers: geminiHeaders(context.apiKey),
        body: JSON.stringify(geminiBody(request)),
        signal: this.requestSignal(context),
      });
    } catch (error) {
      throw Object.assign(new Error('provider_unavailable'), { normalized: this.normalizeError(error) });
    }
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error('provider_error'), { normalized: this.normalizeError(new Error('provider'), response.status) });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('provider_error'), {
        normalized: { code: 'provider_error' as const, message: 'The model provider returned an error.', providerStatus: response.status },
      });
    }
    const content = assertGeminiText(parsed);
    const usage = this.normalizeUsage(parsed);
    return { responseBody: completionBody(request.model, content, usage), usage, providerLatencyMs: Date.now() - started };
  }

  async streamChatCompletion(request: ChatCompletionRequest, context: ProviderContext): Promise<ProviderStream> {
    const started = Date.now();
    const fetchImpl = context.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(
        `${this.baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: geminiHeaders(context.apiKey),
          body: JSON.stringify(geminiBody(request)),
          signal: this.requestSignal(context),
        },
      );
    } catch (error) {
      throw Object.assign(new Error('provider_unavailable'), { normalized: this.normalizeError(error) });
    }
    if (!response.ok || !response.body) {
      throw Object.assign(new Error('provider_error'), { normalized: this.normalizeError(new Error('provider'), response.status) });
    }
    let usage: NormalizedUsage | null = null;
    let firstTokenAt: number | null = null;
    let sawText = false;
    let terminalError: Error | null = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const iterator = (async function* chunks() {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          if (terminalError) {
            throw terminalError;
          }
          if (!sawText) {
            throw Object.assign(new Error('provider_error'), {
              normalized: {
                code: 'provider_error' as const,
                message: 'The model provider returned an error.',
                providerStatus: response.status,
              },
            });
          }
          if (usage) {
            yield sseUsage(usage);
          }
          yield sseDone();
          return;
        }
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue;
          }
          try {
            const data = JSON.parse(line.slice(5).trim()) as unknown;
            const rejection = geminiContentRejection(data);
            if (rejection) {
              terminalError = Object.assign(new Error('provider_content_rejected'), { normalized: rejection });
              continue;
            }
            const normalized = normalizeGeminiUsage(data);
            if (normalized) {
              usage = normalized;
            }
            const text = extractGeminiCandidateText(data);
            if (text) {
              sawText = true;
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
              }
              yield sseText(text);
            }
          } catch {
            continue;
          }
        }
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

function geminiHeaders(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
}

function geminiBody(request: ChatCompletionRequest) {
  const split = splitChatMessages(request.messages);
  const contents = (split.turns.length > 0 ? split.turns : [{ role: 'user' as const, text: '' }]).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.text }],
  }));
  return {
    ...(split.system ? { systemInstruction: { parts: [{ text: split.system }] } } : {}),
    contents,
    generationConfig: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.max_tokens !== undefined ? { maxOutputTokens: request.max_tokens } : {}),
    },
  };
}

const BLOCKED_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

export function geminiContentRejection(raw: unknown): {
  code: 'provider_content_rejected';
  message: string;
  providerStatus: number | null;
} | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  const feedback = record.promptFeedback && typeof record.promptFeedback === 'object'
    ? (record.promptFeedback as Record<string, unknown>)
    : null;
  if (feedback && (feedback.blockReason || feedback.blockReasonMessage)) {
    return {
      code: 'provider_content_rejected',
      message: 'The model provider rejected the content.',
      providerStatus: null,
    };
  }
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const finish = (candidate as { finishReason?: unknown }).finishReason;
    if (typeof finish === 'string' && BLOCKED_FINISH.has(finish)) {
      return {
        code: 'provider_content_rejected',
        message: 'The model provider rejected the content.',
        providerStatus: null,
      };
    }
  }
  return null;
}

export function extractGeminiCandidateText(raw: unknown): string {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const candidates = record && Array.isArray(record.candidates) ? record.candidates : [];
  const first = candidates[0];
  if (!first || typeof first !== 'object') {
    return '';
  }
  const parts = (first as { content?: { parts?: Array<{ text?: string }> } }).content?.parts ?? [];
  return parts.map((part) => part.text ?? '').join('');
}

export function assertGeminiText(raw: unknown): string {
  const rejection = geminiContentRejection(raw);
  if (rejection) {
    throw Object.assign(new Error('provider_content_rejected'), { normalized: rejection });
  }
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const candidates = record && Array.isArray(record.candidates) ? record.candidates : null;
  if (!candidates || candidates.length === 0) {
    throw Object.assign(new Error('provider_error'), {
      normalized: { code: 'provider_error' as const, message: 'The model provider returned an error.', providerStatus: null },
    });
  }
  const content = extractGeminiCandidateText(raw);
  if (!content.trim()) {
    throw Object.assign(new Error('provider_error'), {
      normalized: { code: 'provider_error' as const, message: 'The model provider returned an error.', providerStatus: null },
    });
  }
  return content;
}

export function normalizeGeminiUsage(raw: unknown): NormalizedUsage | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const usage =
    record && typeof record.usageMetadata === 'object' && record.usageMetadata
      ? (record.usageMetadata as Record<string, unknown>)
      : null;
  if (!usage || typeof usage.promptTokenCount !== 'number') {
    return null;
  }
  const output = typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
  const cached = typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0;
  const thoughts = typeof usage.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : 0;
  const total = typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : usage.promptTokenCount + output;
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: output,
    totalTokens: total,
    ...(cached > 0 ? { cachedInputTokens: cached, inputIncludesCached: true } : {}),
    ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
  };
}
