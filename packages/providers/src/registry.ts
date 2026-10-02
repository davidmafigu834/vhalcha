import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { MockModelProvider } from './mock';
import { DEFAULT_PROVIDER_TIMEOUT_MS, OpenAIProvider, type ModelProvider, type ProviderId } from './openai';

/**
 * Production routing asks this registry for the adapter named by the routing decision.
 * VHALCHA_PROVIDER_MODE=openai means real adapters are enabled. It does not lock every request to OpenAI.
 * Mock mode registers only mock adapters so acceptance cannot spend real provider credits.
 */
export interface ProviderRegistry {
  get(provider: string): ModelProvider | null;
}

export function createProviderRegistry(input: {
  timeoutMs?: number;
  includeMock?: boolean;
  overrides?: Partial<Record<ProviderId, ModelProvider>>;
}): ProviderRegistry {
  const timeout = input.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const adapters = new Map<string, ModelProvider>();
  if (input.includeMock) {
    const mock = input.overrides?.mock ?? new MockModelProvider();
    adapters.set('mock', mock);
    // Fixed-mode requests still name provider openai while the process runs in mock mode.
    adapters.set('openai', input.overrides?.openai ?? mock);
    adapters.set('anthropic', input.overrides?.anthropic ?? mock);
    adapters.set('google', input.overrides?.google ?? mock);
  } else {
    adapters.set('openai', input.overrides?.openai ?? new OpenAIProvider('https://api.openai.com/v1', timeout));
    adapters.set('anthropic', input.overrides?.anthropic ?? new AnthropicProvider('https://api.anthropic.com/v1', timeout));
    adapters.set('google', input.overrides?.google ?? new GeminiProvider(undefined, timeout));
  }
  return {
    get(provider: string) {
      return adapters.get(provider) ?? null;
    },
  };
}
