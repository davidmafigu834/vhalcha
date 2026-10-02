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

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic Messages API.
 * https://platform.claude.com/docs/en/build-with-claude/streaming
 * Credential check uses GET /v1/models, not a generation call.
 * Cache-read tokens are billed separately from input_tokens. They are not invented.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic' as const;

  constructor(
    private readonly baseUrl = 'https://api.anthropic.com/v1',
    private readonly timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  private requestSignal(context: ProviderContext): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  }

  normalizeUsage(raw: unknown): NormalizedUsage | null {
    return normalizeAnthropicUsage(raw);
  }

  normalizeError(error: unknown, status?: number) {
    return classifyProviderStatus(status ?? null, error);
  }

  async chatCompletion(request: ChatCompletionRequest, context: ProviderContext): Promise<ProviderChatResult> {
    const started = Date.now();
    const fetchImpl = context.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: anthropicHeaders(context.apiKey),
        body: JSON.stringify(anthropicBody(request, false)),
        signal: this.requestSignal(context),
      });
    } catch (error) {
      throw Object.assign(new Error('provider_unavailable'), { normalized: this.normalizeError(error) });
    }
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error('provider_error'), { normalized: this.normalizeError(new Error('provider'), response.status) });
    }
    const parsed = JSON.parse(text) as { content?: Array<{ type?: string; text?: string }>; usage?: unknown };
    const content = (parsed.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
    const usage = this.normalizeUsage(parsed);
    return { responseBody: completionBody(request.model, content, usage), usage, providerLatencyMs: Date.now() - started };
  }

  async streamChatCompletion(request: ChatCompletionRequest, context: ProviderContext): Promise<ProviderStream> {
    const started = Date.now();
    const fetchImpl = context.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: anthropicHeaders(context.apiKey),
        body: JSON.stringify(anthropicBody(request, true)),
        signal: this.requestSignal(context),
      });
    } catch (error) {
      throw Object.assign(new Error('provider_unavailable'), { normalized: this.normalizeError(error) });
    }
    if (!response.ok || !response.body) {
      throw Object.assign(new Error('provider_error'), { normalized: this.normalizeError(new Error('provider'), response.status) });
    }
    return readSseStream(response, started, (event, data) => {
      if (event === 'content_block_delta') {
        const text = typeof data.delta === 'object' && data.delta && 'text' in data.delta ? String((data.delta as { text?: unknown }).text ?? '') : '';
        return text ? [sseText(text)] : [];
      }
      if (event === 'message_start' || event === 'message_delta') {
        const usage = normalizeAnthropicUsage(event === 'message_start' ? data.message : data);
        return usage ? [sseUsage(usage)] : [];
      }
      return [];
    });
  }
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

function anthropicBody(request: ChatCompletionRequest, stream: boolean) {
  const split = splitChatMessages(request.messages);
  const messages = split.turns.length > 0 ? split.turns.map((turn) => ({ role: turn.role, content: turn.text })) : [{ role: 'user', content: '' }];
  return {
    model: request.model,
    max_tokens: request.max_tokens ?? 1024,
    ...(split.system ? { system: split.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    messages,
    ...(stream ? { stream: true } : {}),
  };
}

export function normalizeAnthropicUsage(raw: unknown): NormalizedUsage | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const usage = record && typeof record.usage === 'object' && record.usage ? (record.usage as Record<string, unknown>) : record;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    return null;
  }
  const cached = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const inputTokens = usage.input_tokens;
  return {
    inputTokens,
    outputTokens: usage.output_tokens,
    totalTokens: inputTokens + cached + usage.output_tokens,
    ...(cached > 0 ? { cachedInputTokens: cached, inputIncludesCached: false } : {}),
  };
}

async function readSseStream(
  response: Response,
  started: number,
  mapEvent: (event: string, data: Record<string, unknown>) => Uint8Array[],
): Promise<ProviderStream> {
  let usage: NormalizedUsage | null = null;
  let firstTokenAt: number | null = null;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let eventName = 'message';
  const iterator = (async function* chunks() {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        yield sseDone();
        return;
      }
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload) {
          continue;
        }
        try {
          const data = JSON.parse(payload) as Record<string, unknown>;
          const normalized = normalizeAnthropicUsage(eventName === 'message_start' ? data.message : data);
          if (normalized) {
            usage = normalized;
          }
          for (const bytes of mapEvent(eventName, data)) {
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
            }
            yield bytes;
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
