import type { ChatCompletionRequest } from '@vhalcha/types';

export interface VhalchaOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class Vhalcha {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VhalchaOptions) {
    if (!options.apiKey) {
      throw new Error('A Vhalcha API key is required.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3001').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  chat = {
    completions: {
      create: async (body: ChatCompletionRequest) => {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
          } | null;
          throw new Error(payload?.error?.message ?? 'The Vhalcha request failed.');
        }
        if (body.stream) {
          return response.body;
        }
        return response.json();
      },
    },
  };
}
