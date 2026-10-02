import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { AppDatabase } from './client';

export const currentTenantDb = new AsyncLocalStorage<AppDatabase>();

export class TenantScopeError extends Error {
  constructor() {
    super('An organisation scope is required.');
    this.name = 'TenantScopeError';
  }
}

export function requireOrganisationId(organisationId: string): string {
  if (!organisationId || organisationId.trim().length === 0) {
    throw new TenantScopeError();
  }
  return organisationId;
}

/**
 * Sets the transaction-local organisation used by row level security.
 * Nested calls reuse the open transaction so row locks stay on one connection.
 */
export async function usingTenant<T>(
  db: AppDatabase,
  organisationId: string,
  run: (tx: AppDatabase) => Promise<T>,
): Promise<T> {
  requireOrganisationId(organisationId);
  const existing = currentTenantDb.getStore();
  if (existing) {
    await existing.execute(sql`select set_config('app.current_organisation_id', ${organisationId}, true)`);
    return run(existing);
  }
  return db.transaction(async (tx) => {
    const bound = tx as unknown as AppDatabase;
    await bound.execute(sql`select set_config('app.current_organisation_id', ${organisationId}, true)`);
    return currentTenantDb.run(bound, () => run(bound));
  });
}
