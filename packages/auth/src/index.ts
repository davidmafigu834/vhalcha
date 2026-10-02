import { createHmac, timingSafeEqual } from 'node:crypto';
import { permissions, type Permission, type UserRole } from '@vhalcha/types';

export type { Permission, UserRole };

const allPermissions: readonly Permission[] = permissions;

const readPermissions = [
  'organisations:read',
  'users:read',
  'environments:read',
  'ai_systems:read',
  'gateway:read',
  'budgets:read',
  'providers:read',
  'audit:read',
  'spend:read',
  'overview:read',
  'settings:read',
  'routing:read',
  'guard:view',
  'guard:audit:view',
] as const satisfies readonly Permission[];

export const rolePermissions: Record<UserRole, readonly Permission[]> = {
  owner: allPermissions,
  ai_admin: allPermissions.filter(
    (permission) =>
      permission !== 'ownership:transfer' &&
      permission !== 'users:write' &&
      permission !== 'guard:policy:activate' &&
      permission !== 'guard:approval:decide' &&
      permission !== 'guard:runtime:configure',
  ),
  developer: [
    'organisations:read',
    'environments:read',
    'ai_systems:read',
    'ai_systems:write',
    'api_keys:read',
    'api_keys:write',
    'gateway:read',
    'budgets:read',
    'budgets:write',
    'providers:read',
    'overview:read',
    'settings:read',
    'settings:developer',
    'spend:read',
    'routing:read',
    'guard:view',
  ],
  security_admin: [
    'organisations:read',
    'environments:read',
    'ai_systems:read',
    'gateway:read',
    'audit:read',
    'budgets:read',
    'providers:read',
    'overview:read',
    'settings:read',
    'spend:read',
    'routing:read',
    'guard:view',
    'guard:configure',
    'guard:policy:create',
    'guard:policy:edit',
    'guard:policy:activate',
    'guard:incident:manage',
    'guard:approval:decide',
    'guard:runtime:configure',
    'guard:audit:view',
  ],
  finance_manager: [
    'organisations:read',
    'environments:read',
    'ai_systems:read',
    'gateway:read',
    'budgets:read',
    'budgets:write',
    'spend:read',
    'overview:read',
    'settings:read',
    'audit:read',
    'routing:read',
    'guard:view',
    'guard:audit:view',
  ],
  viewer: readPermissions,
};

export class AuthorizationError extends Error {
  constructor(permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = 'AuthorizationError';
  }
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export function assertPermission(role: UserRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new AuthorizationError(permission);
  }
}

export function assertRoleChange(input: {
  actorRole: UserRole;
  targetCurrentRole: UserRole;
  nextRole: UserRole;
  ownerCount: number;
}): void {
  if (input.actorRole !== 'owner') {
    throw new AuthorizationError('users:write');
  }
  if (input.targetCurrentRole === 'owner' && input.nextRole !== 'owner' && input.ownerCount <= 1) {
    throw new Error('The organisation must keep one owner.');
  }
}

export interface SessionClaims {
  sid: string;
  uid: string;
  oid: string;
  exp: number;
}

export interface AuthProvider {
  signIn(input: {
    email: string;
    password: string;
  }): Promise<{ token: string; claims: SessionClaims }>;
  signOut(organisationId: string, sessionId: string): Promise<void>;
  getSession(token: string): Promise<{
    claims: SessionClaims;
    sessionId: string;
    role: UserRole;
    email: string;
    name: string;
  } | null>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
}

export function signSession(claims: SessionClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, signature] = parts;
  if (!body || !signature) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
    if (!parsed.sid || !parsed.uid || !parsed.oid || typeof parsed.exp !== 'number') {
      return null;
    }
    if (parsed.exp * 1000 <= now) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
