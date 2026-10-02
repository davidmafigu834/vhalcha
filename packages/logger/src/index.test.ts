import { describe, expect, it } from 'vitest';
import { redactValue } from './index';

describe('redactValue', () => {
  it('removes secrets, virtual keys, and provider keys', () => {
    const redacted = redactValue({
      password: 'hunter2',
      authorization: 'Bearer vh_live_abcdefghijklmnopqrstuvwxyz0123456789',
      note: 'key vh_test_abcdefghijklmnopqrstuvwxyz0123456789 and sk-proj-abcdefghij',
      nested: { apiKey: 'secret', request_id: 'req_123' },
    }) as {
      password: string;
      authorization: string;
      note: string;
      nested: { apiKey: string; request_id: string };
    };

    expect(redacted.password).toBe('[redacted]');
    expect(redacted.authorization).toBe('[redacted]');
    expect(redacted.note).not.toContain('abcdefghij');
    expect(redacted.note).toContain('[redacted]');
    expect(redacted.nested.apiKey).toBe('[redacted]');
    expect(redacted.nested.request_id).toBe('req_123');
  });
});
