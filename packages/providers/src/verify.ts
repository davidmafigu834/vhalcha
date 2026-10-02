import { classifyProviderStatus, type ProviderErrorCode, type ProviderId } from './openai';

export interface CredentialVerification {
  ok: boolean;
  code: 'verified' | ProviderErrorCode;
}

/**
 * Cheap authentication checks. These do not generate tokens.
 * OpenAI: GET /v1/models
 * Anthropic: GET /v1/models
 * Google: GET /v1beta/models
 */
export async function verifyProviderCredential(input: {
  provider: ProviderId;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CredentialVerification> {
  if (input.provider === 'mock') {
    return { ok: true, code: 'verified' };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 10_000);
  const target = verificationRequest(input.provider, input.apiKey);
  try {
    const response = await fetchImpl(target.url, { method: 'GET', headers: target.headers, signal: timeout });
    if (response.ok) {
      return { ok: true, code: 'verified' };
    }
    const normalized = classifyProviderStatus(response.status);
    return { ok: false, code: normalized.code };
  } catch (error) {
    const normalized = classifyProviderStatus(null, error);
    return { ok: false, code: normalized.code };
  }
}

function verificationRequest(provider: Exclude<ProviderId, 'mock'>, apiKey: string): { url: string; headers: Record<string, string> } {
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    };
  }
  if (provider === 'google') {
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      headers: { 'x-goog-api-key': apiKey },
    };
  }
  return {
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  };
}
