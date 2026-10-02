import { describe, expect, it } from 'vitest';
import { verifyProviderCredential } from './verify';

describe('verifyProviderCredential', () => {
  it('marks a 200 models list as verified without generating tokens', async () => {
    const result = await verifyProviderCredential({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      fetchImpl: async (input, init) => {
        expect(String(input)).toContain('/v1/models');
        expect(init?.method).toBe('GET');
        return new Response('{"data":[]}', { status: 200 });
      },
    });
    expect(result).toEqual({ ok: true, code: 'verified' });
  });

  it('maps authentication failure without returning the vendor body', async () => {
    const result = await verifyProviderCredential({
      provider: 'google',
      apiKey: 'bad',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'secret' } }), { status: 401 }),
    });
    expect(result).toEqual({ ok: false, code: 'provider_authentication_failed' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('maps rate limits and server errors safely', async () => {
    await expect(
      verifyProviderCredential({
        provider: 'openai',
        apiKey: 'sk',
        fetchImpl: async () => new Response('rate', { status: 429 }),
      }),
    ).resolves.toEqual({ ok: false, code: 'provider_rate_limited' });
    await expect(
      verifyProviderCredential({
        provider: 'openai',
        apiKey: 'sk',
        fetchImpl: async () => new Response('down', { status: 503 }),
      }),
    ).resolves.toEqual({ ok: false, code: 'provider_unavailable' });
  });

  it('maps timeouts without leaking vendor bodies', async () => {
    const result = await verifyProviderCredential({
      provider: 'openai',
      apiKey: 'sk',
      timeoutMs: 5,
      fetchImpl: async () => {
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      },
    });
    expect(result).toEqual({ ok: false, code: 'provider_timeout' });
  });

  it('treats malformed successful payloads as verified when HTTP is ok', async () => {
    // Models list auth check only needs HTTP success; body is not parsed for routing eligibility.
    const result = await verifyProviderCredential({
      provider: 'openai',
      apiKey: 'sk',
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    });
    expect(result).toEqual({ ok: true, code: 'verified' });
  });
});
