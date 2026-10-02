import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from './openai';

describe('OpenAIProvider', () => {
  it('returns provider usage without retaining a pricing side effect', async () => {
    const provider = new OpenAIProvider('https://example.test/v1');
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      expect(body.stream).toBeUndefined();
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const result = await provider.chatCompletion(
      { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hello' }] },
      { apiKey: 'sk-test', fetchImpl },
    );
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it('forwards stream bytes before the stream finishes', async () => {
    const provider = new OpenAIProvider('https://example.test/v1');
    const encoder = new TextEncoder();
    const release: { current: () => void } = { current: () => undefined };
    const second = new Promise<void>((resolve) => {
      release.current = () => resolve();
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          ),
        );
        await second;
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchImpl: typeof fetch = async () => new Response(stream, { status: 200 });
    const opened = await provider.streamChatCompletion(
      { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hello' }], stream: true },
      { apiKey: 'sk-test', fetchImpl },
    );
    const iterator = opened.chunks[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value).toString('utf8')).toContain('Hello');
    release.current();
    await iterator.next();
    await iterator.next();
    expect(opened.usage()).toEqual({ inputTokens: 4, outputTokens: 1, totalTokens: 5 });
  });

  it('aborts a non-streaming request when the provider exceeds the timeout', async () => {
    const provider = new OpenAIProvider('https://example.test/v1', 30);
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          reject(error);
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener('abort', abort, { once: true });
      });
    await expect(
      provider.chatCompletion(
        { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hello' }] },
        { apiKey: 'sk-test', fetchImpl },
      ),
    ).rejects.toMatchObject({ normalized: { code: 'provider_timeout' } });
  });

  it('maps provider failures to a safe error', () => {
    const provider = new OpenAIProvider();
    expect(provider.normalizeError(new Error('secret prompt echoed'), 400)).toEqual({
      code: 'provider_invalid_request',
      message: 'The model provider rejected the request.',
      providerStatus: 400,
    });
    expect(provider.normalizeError(new Error('secret prompt echoed'), 400).message).not.toContain('secret');
  });
});
