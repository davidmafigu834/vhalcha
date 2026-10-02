import { describe, expect, it } from 'vitest';
import { consumeRateLimit, MemoryRedis, redisKeys } from './index';

describe('rate limits', () => {
  it('allows the configured number of requests per window and then blocks', async () => {
    const store = new MemoryRedis();
    const now = new Date('2026-09-28T00:00:30.000Z');
    const input = {
      organisationId: 'org-a',
      aiSystemId: 'system-a',
      limit: 2,
      now,
    };
    expect((await consumeRateLimit(store, input)).allowed).toBe(true);
    expect((await consumeRateLimit(store, input)).remaining).toBe(0);
    const blocked = await consumeRateLimit(store, input);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetAtEpochSeconds).toBeGreaterThan(Math.floor(now.getTime() / 1000));
  });

  it('namespaces keys by organisation and AI system', () => {
    expect(redisKeys.rate('org', 'system', 10)).toBe('vhalcha:rate:org:system:10');
    expect(redisKeys.key('abc')).toBe('vhalcha:key:abc');
    expect(redisKeys.budget('monthly', 'org', 'system', '2026-09')).toBe(
      'vhalcha:budget:monthly:org:system:2026-09',
    );
  });
});
