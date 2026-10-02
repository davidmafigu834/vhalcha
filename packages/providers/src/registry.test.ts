import { describe, expect, it } from 'vitest';
import { createProviderRegistry, MockModelProvider } from './index';

describe('createProviderRegistry', () => {
  it('registers only mock adapters in mock mode so real vendors cannot be reached', () => {
    const mock = new MockModelProvider();
    const registry = createProviderRegistry({ includeMock: true, overrides: { mock, openai: mock, anthropic: mock, google: mock } });
    expect(registry.get('openai')).toBe(mock);
    expect(registry.get('anthropic')).toBe(mock);
    expect(registry.get('google')).toBe(mock);
    expect(registry.get('mock')).toBe(mock);
  });

  it('registers real adapters when mock mode is off', () => {
    const registry = createProviderRegistry({ includeMock: false });
    expect(registry.get('openai')?.id).toBe('openai');
    expect(registry.get('anthropic')?.id).toBe('anthropic');
    expect(registry.get('google')?.id).toBe('google');
    expect(registry.get('mock')).toBeNull();
  });
});
