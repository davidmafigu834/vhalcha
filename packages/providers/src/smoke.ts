/**
 * Live provider smoke helper. Invoked only by explicit pnpm smoke:* scripts.
 * Never imported by unit tests or acceptance.
 */
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OpenAIProvider } from './openai';
import type { ModelProvider } from './openai';

const PLACEHOLDER = /^(changeme|your-|sk-test|example|placeholder|xxx)/i;

export interface SmokeResult {
  provider: string;
  model: string;
  completionText: string;
  completionUsage: unknown;
  streamSawText: boolean;
  streamUsage: unknown;
}

function requireKey(name: string, value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed || PLACEHOLDER.test(trimmed) || trimmed.length < 8) {
    throw new Error(`${name} is missing or looks like a placeholder. Smoke tests refuse to run.`);
  }
  return trimmed;
}

async function readStreamText(provider: ModelProvider, model: string, apiKey: string): Promise<{ text: string; usage: unknown }> {
  const opened = await provider.streamChatCompletion(
    {
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 8,
      temperature: 0,
    },
    { apiKey },
  );
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of opened.chunks) {
    const payload = decoder.decode(chunk);
    const match = payload.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match?.[1]) {
      text += match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }
  return { text, usage: opened.usage() };
}

export async function runProviderSmoke(input: {
  provider: 'openai' | 'anthropic' | 'google';
  model: string;
  apiKeyEnv: string;
}): Promise<SmokeResult> {
  const apiKey = requireKey(input.apiKeyEnv, process.env[input.apiKeyEnv]);
  const provider: ModelProvider =
    input.provider === 'anthropic'
      ? new AnthropicProvider()
      : input.provider === 'google'
        ? new GeminiProvider()
        : new OpenAIProvider();
  console.log(`smoke provider=${input.provider} model=${input.model}`);
  const completion = await provider.chatCompletion(
    {
      model: input.model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 8,
      temperature: 0,
    },
    { apiKey },
  );
  const body = completion.responseBody as { choices?: Array<{ message?: { content?: string } }> };
  const completionText = body.choices?.[0]?.message?.content?.trim() ?? '';
  if (!completionText) {
    throw new Error('Completion returned empty text.');
  }
  console.log(`smoke completion ok chars=${completionText.length} usage=${completion.usage ? 'present' : 'missing'}`);
  const stream = await readStreamText(provider, input.model, apiKey);
  if (!stream.text.trim()) {
    throw new Error('Stream returned no text deltas.');
  }
  console.log(`smoke stream ok chars=${stream.text.trim().length} usage=${stream.usage ? 'present' : 'missing'}`);
  return {
    provider: input.provider,
    model: input.model,
    completionText,
    completionUsage: completion.usage,
    streamSawText: true,
    streamUsage: stream.usage,
  };
}
