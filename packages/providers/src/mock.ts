import type { ChatCompletionRequest } from '@vhalcha/types';
import { OpenAIProvider, normalizeOpenAiError, normalizeOpenAiUsage, type ModelProvider, type NormalizedUsage, type ProviderContext } from './openai';

export const MOCK_PROVIDER_TEXT = 'Vhalcha development provider response.';
const SIMULATE_ERROR = 'VHALCHA_SIMULATE_PROVIDER_ERROR';

const usage: NormalizedUsage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };

function mockAssistantText(request: ChatCompletionRequest) {
  const joined = request.messages.map((message) => message.content).join('\n');
  if (joined.includes('VHALCHA APPROVED KNOWLEDGE') && joined.includes('[S1]')) {
    return `${MOCK_PROVIDER_TEXT} [S1]`;
  }
  return MOCK_PROVIDER_TEXT;
}

function completionBody(request: ChatCompletionRequest) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: mockAssistantText(request) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens },
  };
}

function wantsError(request: ChatCompletionRequest) {
  return request.messages.some((message) => message.content.includes(SIMULATE_ERROR));
}

export class MockModelProvider implements ModelProvider {
  readonly id = 'openai' as const;
  readonly calls = { chat: 0, stream: 0 };
  readonly failModels = new Set<string>();
  lastModel = '';

  async chatCompletion(request: ChatCompletionRequest, _context: ProviderContext) {
    this.calls.chat += 1;
    this.lastModel = request.model;
    if (this.failModels.has(request.model) || wantsError(request)) {
      throw Object.assign(new Error('mock provider failure'), {
        normalized: normalizeOpenAiError(new Error('mock provider failure'), 503),
      });
    }
    return {
      responseBody: completionBody(request),
      usage,
      providerLatencyMs: 5,
    };
  }

  async streamChatCompletion(request: ChatCompletionRequest, _context: ProviderContext) {
    this.calls.stream += 1;
    this.lastModel = request.model;
    if (this.failModels.has(request.model) || wantsError(request)) {
      throw Object.assign(new Error('mock provider failure'), {
        normalized: normalizeOpenAiError(new Error('mock provider failure'), 503),
      });
    }
    const encoder = new TextEncoder();
    const started = Date.now();
    async function* chunks() {
      yield encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: mockAssistantText(request) } }] })}\n\n`,
      );
      yield encoder.encode(
        `data: ${JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`,
      );
      yield encoder.encode('data: [DONE]\n\n');
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      chunks: chunks(),
      usage: () => usage,
      timeToFirstTokenMs: () => 1,
      providerLatencyMs: () => Date.now() - started,
    };
  }

  normalizeUsage(raw: unknown) {
    return normalizeOpenAiUsage(raw);
  }

  normalizeError(error: unknown, status?: number) {
    return normalizeOpenAiError(error, status);
  }
}

export function createRuntimeProvider(
  mode: 'openai' | 'mock',
  environment: string,
  timeoutMs?: number,
): ModelProvider {
  if (mode === 'mock') {
    if (environment === 'production') {
      throw new Error('Invalid environment configuration: VHALCHA_PROVIDER_MODE');
    }
    return new MockModelProvider();
  }
  return new OpenAIProvider('https://api.openai.com/v1', timeoutMs);
}
