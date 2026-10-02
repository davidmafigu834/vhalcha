import { describe, expect, it } from 'vitest';
import { safeAuditMetadata } from './index';

describe('safeAuditMetadata', () => {
  it('drops prompt content and keeps operational fields', () => {
    expect(
      safeAuditMetadata({
        prompt: 'secret customer text',
        model: 'gpt-4.1-mini',
        ai_system_id: 'sys',
        input_tokens: 12,
      }),
    ).toEqual({
      model: 'gpt-4.1-mini',
      ai_system_id: 'sys',
      input_tokens: 12,
    });
  });
});
