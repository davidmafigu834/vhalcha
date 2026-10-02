import { describe, expect, it } from 'vitest';
import { Vhalcha } from './index';

describe('Vhalcha SDK', () => {
  it('sends the virtual key and returns the JSON completion', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(String(init?.headers && (init.headers as Record<string, string>).authorization)).toContain(
        'Bearer vh_test_',
      );
      return new Response(JSON.stringify({ id: 'chatcmpl-sdk' }), { status: 200 });
    };
    const client = new Vhalcha({
      apiKey: 'vh_test_example',
      baseUrl: 'http://gateway.local',
      fetchImpl,
    });
    const result = (await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Hello' }],
    })) as { id: string };
    expect(result.id).toBe('chatcmpl-sdk');
  });
});
