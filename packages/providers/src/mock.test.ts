import { describe, expect, it } from 'vitest';
import { createRuntimeProvider, MOCK_PROVIDER_TEXT } from './mock';

describe('mock provider', () => {
  it('is refused in production and returns a deterministic completion otherwise', async () => {
    expect(() => createRuntimeProvider('mock', 'production')).toThrow(/VHALCHA_PROVIDER_MODE/);
    const provider = createRuntimeProvider('mock', 'development');
    const result = await provider.chatCompletion(
      { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hello' }] },
      { apiKey: 'mock-provider' },
    );
    expect(JSON.stringify(result.responseBody)).toContain(MOCK_PROVIDER_TEXT);
    await expect(
      provider.chatCompletion(
        { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'VHALCHA_SIMULATE_PROVIDER_ERROR' }] },
        { apiKey: 'mock-provider' },
      ),
    ).rejects.toBeTruthy();
  });
});
