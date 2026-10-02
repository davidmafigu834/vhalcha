import { describe, expect, it } from 'vitest';
import { assertPermission, assertRoleChange, hasPermission, signSession, verifySession } from './index';

const secret = 'dev-only-change-this-session-secret-32b';

describe('role permissions', () => {
  it('gives the owner every capability and keeps viewers read-only', () => {
    expect(hasPermission('owner', 'ownership:transfer')).toBe(true);
    expect(hasPermission('ai_admin', 'ownership:transfer')).toBe(false);
    expect(hasPermission('ai_admin', 'api_keys:write')).toBe(true);
    expect(hasPermission('developer', 'api_keys:write')).toBe(true);
    expect(hasPermission('developer', 'users:write')).toBe(false);
    expect(hasPermission('security_admin', 'audit:read')).toBe(true);
    expect(hasPermission('security_admin', 'api_keys:write')).toBe(false);
    expect(hasPermission('finance_manager', 'budgets:write')).toBe(true);
    expect(hasPermission('finance_manager', 'api_keys:write')).toBe(false);
    expect(hasPermission('viewer', 'ai_systems:write')).toBe(false);
    expect(hasPermission('viewer', 'api_keys:read')).toBe(false);
    expect(hasPermission('viewer', 'overview:read')).toBe(true);
    expect(hasPermission('developer', 'gateway:read')).toBe(true);
    expect(hasPermission('developer', 'api_keys:write')).toBe(true);
    expect(hasPermission('developer', 'audit:read')).toBe(false);
    expect(hasPermission('finance_manager', 'spend:read')).toBe(true);
    expect(hasPermission('finance_manager', 'api_keys:read')).toBe(false);
    expect(hasPermission('finance_manager', 'api_keys:write')).toBe(false);
    expect(hasPermission('security_admin', 'audit:read')).toBe(true);
    expect(hasPermission('security_admin', 'api_keys:write')).toBe(false);
    expect(hasPermission('ai_admin', 'users:write')).toBe(false);
    expect(hasPermission('owner', 'users:write')).toBe(true);
    expect(hasPermission('owner', 'knowledge:write')).toBe(true);
    expect(hasPermission('ai_admin', 'knowledge:manage_access')).toBe(true);
    expect(hasPermission('developer', 'knowledge:read')).toBe(false);
    expect(hasPermission('developer', 'knowledge:write')).toBe(false);
    expect(hasPermission('security_admin', 'knowledge:read')).toBe(false);
    expect(hasPermission('finance_manager', 'knowledge:read')).toBe(false);
    expect(hasPermission('viewer', 'knowledge:read')).toBe(false);
    expect(hasPermission('developer', 'guard:view')).toBe(true);
    expect(hasPermission('developer', 'guard:configure')).toBe(false);
    expect(hasPermission('developer', 'guard:policy:activate')).toBe(false);
    expect(hasPermission('developer', 'guard:policy:create')).toBe(false);
    expect(hasPermission('owner', 'guard:policy:activate')).toBe(true);
    expect(hasPermission('developer', 'guard:audit:view')).toBe(false);
    expect(hasPermission('viewer', 'guard:view')).toBe(true);
    expect(hasPermission('viewer', 'guard:audit:view')).toBe(true);
    expect(hasPermission('viewer', 'guard:configure')).toBe(false);
    expect(hasPermission('security_admin', 'guard:policy:activate')).toBe(true);
    expect(hasPermission('security_admin', 'guard:audit:view')).toBe(true);
    expect(hasPermission('ai_admin', 'guard:configure')).toBe(true);
    expect(hasPermission('ai_admin', 'guard:policy:activate')).toBe(false);
    expect(hasPermission('ai_admin', 'guard:approval:decide')).toBe(false);
    expect(hasPermission('owner', 'guard:approval:decide')).toBe(true);
    expect(hasPermission('finance_manager', 'guard:view')).toBe(true);
    expect(hasPermission('finance_manager', 'guard:configure')).toBe(false);
    expect(() => assertPermission('viewer', 'budgets:write')).toThrow(/Missing permission/);
  });

  it('allows only an owner to change roles and keeps the last owner', () => {
    expect(() =>
      assertRoleChange({
        actorRole: 'ai_admin',
        targetCurrentRole: 'developer',
        nextRole: 'viewer',
        ownerCount: 1,
      }),
    ).toThrow(/Missing permission: users:write/);
    expect(() =>
      assertRoleChange({
        actorRole: 'owner',
        targetCurrentRole: 'developer',
        nextRole: 'finance_manager',
        ownerCount: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertRoleChange({
        actorRole: 'owner',
        targetCurrentRole: 'owner',
        nextRole: 'viewer',
        ownerCount: 1,
      }),
    ).toThrow(/keep one owner/);
    expect(() =>
      assertRoleChange({
        actorRole: 'owner',
        targetCurrentRole: 'owner',
        nextRole: 'viewer',
        ownerCount: 2,
      }),
    ).not.toThrow();
  });
});

describe('session tokens', () => {
  it('rejects tampered and expired tokens', () => {
    const token = signSession(
      { sid: 'session', uid: 'user', oid: 'org', exp: Math.floor(Date.now() / 1000) + 60 },
      secret,
    );
    expect(verifySession(token, secret)?.sid).toBe('session');
    expect(verifySession(`${token}x`, secret)).toBeNull();
    const expired = signSession(
      { sid: 'session', uid: 'user', oid: 'org', exp: Math.floor(Date.now() / 1000) - 10 },
      secret,
    );
    expect(verifySession(expired, secret)).toBeNull();
  });
});
