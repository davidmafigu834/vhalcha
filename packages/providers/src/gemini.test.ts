import { describe, expect, it } from 'vitest';
import { assertGeminiText, geminiContentRejection, GeminiProvider, normalizeGeminiUsage } from './gemini';

describe('GeminiProvider', () => {
  it('maps chat turns into Gemini contents and extracts usage', async () => {
    const provider = new GeminiProvider('https://example.test/v1beta');
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toContain('/models/gemini-2.5-flash:generateContent');
      const body = JSON.parse(String(init?.body)) as {
        systemInstruction?: { parts: Array<{ text: string }> };
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      };
      expect(body.systemInstruction?.parts[0]?.text).toBe('Be brief.');
      expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: {
            promptTokenCount: 9,
            candidatesTokenCount: 2,
            totalTokenCount: 11,
            cachedContentTokenCount: 1,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const result = await provider.chatCompletion(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hello' },
        ],
      },
      { apiKey: 'google-key', fetchImpl },
    );
    expect(result.usage).toEqual({
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
      cachedInputTokens: 1,
      inputIncludesCached: true,
    });
  });

  it('does not invent cached tokens when Google omits them', () => {
    expect(normalizeGeminiUsage({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } })).toEqual({
      inputTokens: 4,
      outputTokens: 1,
      totalTokens: 5,
    });
  });

  it('rejects empty candidates instead of succeeding with blank text', async () => {
    const provider = new GeminiProvider('https://example.test/v1beta');
    await expect(
      provider.chatCompletion(
        { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] },
        {
          apiKey: 'google-key',
          fetchImpl: async () =>
            new Response(JSON.stringify({ candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
        },
      ),
    ).rejects.toMatchObject({ normalized: { code: 'provider_error' } });
  });

  it('maps blocked promptFeedback to provider_content_rejected', () => {
    expect(
      geminiContentRejection({
        promptFeedback: { blockReason: 'SAFETY' },
        candidates: [],
      }),
    ).toEqual({
      code: 'provider_content_rejected',
      message: 'The model provider rejected the content.',
      providerStatus: null,
    });
    expect(() =>
      assertGeminiText({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '' }] } }],
      }),
    ).toThrow(/provider_content_rejected/);
  });
});
