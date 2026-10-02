import { describe, expect, it } from 'vitest';
import { chatCompletionRequestSchema, GatewayError } from './index';

describe('chat completion schema', () => {
  it('accepts the supported fields', () => {
    const parsed = chatCompletionRequestSchema.parse({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Explain our return policy.' }],
      temperature: 0.2,
      max_tokens: 200,
      stream: true,
    });
    expect(parsed.model).toBe('gpt-4.1-mini');
  });

  it('rejects unknown fields instead of forwarding them', () => {
    const result = chatCompletionRequestSchema.safeParse({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('GatewayError', () => {
  it('uses HTTP 402 for budget enforcement', () => {
    const error = new GatewayError('budget_exceeded', 'The AI system budget has been exceeded.');
    expect(error.statusCode).toBe(402);
    expect(error.toJSON()).toEqual({
      error: {
        code: 'budget_exceeded',
        message: 'The AI system budget has been exceeded.',
      },
    });
  });
});
