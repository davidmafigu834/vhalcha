import { describe, expect, it } from 'vitest';
import { AnthropicProvider, normalizeAnthropicUsage } from './anthropic';

describe('AnthropicProvider', () => {
  it('maps messages and usage without retaining vendor error bodies', async () => {
    const provider = new AnthropicProvider('https://example.test/v1');
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        system?: string;
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
      };
      expect(body.system).toBe('Be brief.');
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(body.stream).toBeUndefined();
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const result = await provider.chatCompletion(
      {
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hello' },
        ],
      },
      { apiKey: 'sk-ant-test', fetchImpl },
    );
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 17,
      cachedInputTokens: 2,
      inputIncludesCached: false,
    });
    expect(JSON.stringify(result.responseBody)).toContain('ok');
  });

  it('normalizes Anthropic usage with separate cache reads', () => {
    expect(
      normalizeAnthropicUsage({
        usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 },
      }),
    ).toMatchObject({ inputTokens: 10, cachedInputTokens: 5, inputIncludesCached: false, totalTokens: 18 });
  });
});
