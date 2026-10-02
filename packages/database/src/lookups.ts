import { sql } from 'drizzle-orm';
import type { AppDatabase } from './client';

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value : new Date(String(value));
}

function text(value: unknown): string {
  return String(value ?? '');
}

export async function lookupVirtualApiKey(db: AppDatabase, keyHash: string) {
  const result = await db.execute(sql`select * from app.lookup_virtual_api_key(${keyHash})`);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  if (!row) {
    return null;
  }
  return {
    id: text(row.id),
    organisationId: text(row.organisation_id),
    aiSystemId: text(row.ai_system_id),
    environmentId: text(row.environment_id),
    name: text(row.name),
    keyPrefix: text(row.key_prefix),
    keyHash: text(row.key_hash),
    status: text(row.status),
    createdAt: asDate(row.created_at) ?? new Date(0),
    expiresAt: asDate(row.expires_at),
    lastUsedAt: asDate(row.last_used_at),
    revokedAt: asDate(row.revoked_at),
  };
}

export async function lookupUsersByEmail(db: AppDatabase, email: string) {
  const result = await db.execute(sql`select * from app.lookup_user_by_email(${email})`);
  return rowsOf<Record<string, unknown>>(result).map(mapUser);
}

export async function lookupUserById(db: AppDatabase, userId: string) {
  const result = await db.execute(sql`select * from app.lookup_user_by_id(${userId})`);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  return row ? mapUser(row) : null;
}

export async function lookupSessionByHash(db: AppDatabase, tokenHash: string) {
  const result = await db.execute(sql`select * from app.lookup_session(${tokenHash})`);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  if (!row) {
    return null;
  }
  return {
    id: text(row.id),
    userId: text(row.user_id),
    organisationId: text(row.organisation_id),
    tokenHash: text(row.token_hash),
    expiresAt: asDate(row.expires_at) ?? new Date(0),
    createdAt: asDate(row.created_at) ?? new Date(0),
    revokedAt: asDate(row.revoked_at),
  };
}

export async function lookupPasswordReset(db: AppDatabase, tokenHash: string) {
  const result = await db.execute(sql`select * from app.lookup_password_reset(${tokenHash})`);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  if (!row) {
    return null;
  }
  return {
    id: text(row.id),
    userId: text(row.user_id),
    organisationId: text(row.organisation_id),
    tokenHash: text(row.token_hash),
    expiresAt: asDate(row.expires_at) ?? new Date(0),
    usedAt: asDate(row.used_at),
    createdAt: asDate(row.created_at) ?? new Date(0),
  };
}

export async function lookupOrganisationBySlug(db: AppDatabase, slug: string) {
  const result = await db.execute(sql`select * from app.lookup_organisation_by_slug(${slug})`);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  if (!row) {
    return null;
  }
  return {
    id: text(row.id),
    name: text(row.name),
    slug: text(row.slug),
    status: text(row.status),
    defaultCurrency: text(row.default_currency),
    timezone: text(row.timezone),
    contentLoggingMode: text(row.content_logging_mode),
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
  };
}

function mapUser(row: Record<string, unknown>) {
  return {
    id: text(row.id),
    organisationId: text(row.organisation_id),
    email: text(row.email),
    name: text(row.name),
    role: text(row.role),
    status: text(row.status),
    passwordHash: row.password_hash === null || row.password_hash === undefined ? null : text(row.password_hash),
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
  };
}
