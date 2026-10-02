import { describe, expect, it } from 'vitest';
import { hasPermission } from '@vhalcha/auth';
import { readIfAllowed } from './access';

describe('dashboard read authorization', () => {
  it('does not load API key metadata for a viewer, finance manager, or security admin', async () => {
    for (const role of ['viewer', 'finance_manager', 'security_admin'] as const) {
      let loaded = 0;
      const keys = await readIfAllowed(role, 'api_keys:read', async () => {
        loaded += 1;
        return [{ keyPrefix: 'vh_test_secret', lastUsedAt: 'now', status: 'active' }];
      });
      expect(keys).toBeNull();
      expect(loaded).toBe(0);
    }
  });

  it('lets a developer read key metadata and gateway data', async () => {
    const keys = await readIfAllowed('developer', 'api_keys:read', async () => ['prefix']);
    expect(keys).toEqual(['prefix']);
    expect(hasPermission('developer', 'gateway:read')).toBe(true);
    expect(hasPermission('developer', 'spend:read')).toBe(true);
    expect(hasPermission('developer', 'ai_systems:write')).toBe(true);
  });

  it('lets finance read spend and blocks key management', async () => {
    expect(hasPermission('finance_manager', 'spend:read')).toBe(true);
    expect(hasPermission('finance_manager', 'budgets:write')).toBe(true);
    expect(hasPermission('finance_manager', 'api_keys:write')).toBe(false);
    expect(hasPermission('finance_manager', 'api_keys:read')).toBe(false);
  });

  it('lets security read audit and blocks key rotation', async () => {
    expect(hasPermission('security_admin', 'audit:read')).toBe(true);
    expect(hasPermission('security_admin', 'api_keys:write')).toBe(false);
  });
});
