import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { auditActions, safeAuditMetadata, type AuditDraft } from '@vhalcha/audit';
import type { EnvironmentType, UserRole } from '@vhalcha/types';
import { generateVirtualApiKey } from '@vhalcha/security';
import type { AppDatabase } from './client';
import {
  aiSystems,
  auditEvents,
  budgetReservations,
  budgets,
  environments,
  modelAccessRules,
  organisations,
  passwordResetTokens,
  policyEvents,
  providerConnections,
  requests,
  sessions,
  spendSummaries,
  usageEvents,
  users,
  virtualApiKeys,
} from './schema';
import {
  lookupOrganisationBySlug,
  lookupPasswordReset,
  lookupSessionByHash,
  lookupUserById,
  lookupUsersByEmail,
  lookupVirtualApiKey,
} from './lookups';
import { currentTenantDb, requireOrganisationId, usingTenant } from './tenant';
import { slugify, toMicroUsd, toNumber, toNumeric } from './money';

type ScopedRepositories = ReturnType<typeof createRepositories>;

type BudgetSpendRow = {
  id: string;
  name: string;
  period: string;
  amountUsd: string | number;
  warningThresholdPercent: number;
  hardLimit: boolean;
  action: string;
  aiSystemId: string | null;
  environmentId: string | null;
};

async function lockBudgetRows(tx: AppDatabase, organisationId: string, budgetIds: string[]) {
  if (budgetIds.length === 0) {
    return;
  }
  await tx
    .select({ id: budgets.id })
    .from(budgets)
    .where(and(eq(budgets.organisationId, organisationId), inArray(budgets.id, [...budgetIds].sort())))
    .orderBy(asc(budgets.id))
    .for('update');
}

async function committedForBudget(
  scoped: ScopedRepositories,
  organisationId: string,
  budget: BudgetSpendRow,
  period: { start: Date; end: Date },
): Promise<number> {
  if (budget.aiSystemId) {
    return scoped.usage.sumCost(organisationId, budget.aiSystemId, period.start, period.end);
  }
  if (budget.environmentId) {
    return scoped.usage.sumEnvironmentCost(organisationId, budget.environmentId, period.start, period.end);
  }
  return scoped.usage.sumOrganisationCost(organisationId, period.start, period.end);
}

async function activeHoldUsd(tx: AppDatabase, organisationId: string, budgetId: string, now: Date): Promise<number> {
  const heldRows = await tx
    .select({
      total: sql<string>`coalesce(sum(${budgetReservations.reservedUsd}), 0)::text`,
    })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.organisationId, organisationId),
        eq(budgetReservations.budgetId, budgetId),
        eq(budgetReservations.status, 'reserved'),
        gt(budgetReservations.expiresAt, now),
      ),
    );
  return toNumber(heldRows[0]?.total);
}

function isBlockingBudget(budget: { hardLimit: boolean; action: string }) {
  return budget.hardLimit || budget.action === 'block';
}

export class BudgetReservationRejected extends Error {
  readonly budgetId: string;
  readonly budgetName: string;
  readonly spendUsd: number;
  readonly amountUsd: number;

  constructor(input: { budgetId: string; budgetName: string; spendUsd: number; amountUsd: number }) {
    super('Budget reservation rejected');
    this.name = 'BudgetReservationRejected';
    this.budgetId = input.budgetId;
    this.budgetName = input.budgetName;
    this.spendUsd = input.spendUsd;
    this.amountUsd = input.amountUsd;
  }
}

/**
 * Key-hash lookup is the one intentionally unscoped read.
 * The hash resolves the tenant. Every later read uses that organisation id.
 */
export async function findVirtualKeyByHash(db: AppDatabase, keyHash: string) {
  return lookupVirtualApiKey(db, keyHash);
}

export function createRepositories(database: AppDatabase) {
  const db = new Proxy(database, {
    get(target, property, receiver) {
      const active = currentTenantDb.getStore() ?? target;
      const value = Reflect.get(active, property, receiver);
      return typeof value === 'function' ? value.bind(active) : value;
    },
  }) as AppDatabase;
  return {
    organisations: {
      async findById(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select()
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .limit(1);
          return rows[0] ?? null;
        });
      },
      async findBySlug(slug: string) {
        return lookupOrganisationBySlug(db, slug);
      },
      async create(input: { name: string; slug: string; timezone?: string }) {
        const now = new Date();
        const row = {
          id: randomUUID(),
          name: input.name,
          slug: input.slug,
          status: 'active',
          defaultCurrency: 'USD',
          timezone: input.timezone ?? 'UTC',
          contentLoggingMode: 'metadata_only',
          createdAt: now,
          updatedAt: now,
        };
        await usingTenant(db, row.id, async (tx) => {
          await tx.insert(organisations).values(row);
        });
        return row;
      },
      async update(organisationId: string, patch: { name?: string; timezone?: string }) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          await db
            .update(organisations)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(organisations.id, organisationId));
          return this.findById(organisationId);
        });
      },
    },
    users: {
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select({
              id: users.id,
              organisationId: users.organisationId,
              email: users.email,
              name: users.name,
              role: users.role,
              status: users.status,
              createdAt: users.createdAt,
            })
            .from(users)
            .where(eq(users.organisationId, organisationId))
            .orderBy(users.email);
        });
      },
      async findById(organisationId: string, userId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select()
            .from(users)
            .where(and(eq(users.organisationId, organisationId), eq(users.id, userId)))
            .limit(1);
          return rows[0] ?? null;
        });
      },
      async findByEmail(email: string) {
        return lookupUsersByEmail(db, email);
      },
      async findByPrimaryKey(userId: string) {
        return lookupUserById(db, userId);
      },
      async create(input: {
        organisationId: string;
        email: string;
        name: string;
        role: UserRole;
        passwordHash: string | null;
      }) {
        requireOrganisationId(input.organisationId);
        const now = new Date();
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          email: input.email.toLowerCase(),
          name: input.name,
          role: input.role,
          status: 'active',
          passwordHash: input.passwordHash,
          createdAt: now,
          updatedAt: now,
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(users).values(row);
        });
        return row;
      },
      async updateRole(organisationId: string, userId: string, role: UserRole) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          await db
            .update(users)
            .set({ role, updatedAt: new Date() })
            .where(and(eq(users.organisationId, organisationId), eq(users.id, userId)));
        });
      },
      async updatePassword(organisationId: string, userId: string, passwordHash: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          await db
            .update(users)
            .set({ passwordHash, updatedAt: new Date() })
            .where(and(eq(users.organisationId, organisationId), eq(users.id, userId)));
        });
      },
    },
    sessions: {
      async create(input: { userId: string; organisationId: string; tokenHash: string; expiresAt: Date }) {
        requireOrganisationId(input.organisationId);
        return usingTenant(db, input.organisationId, async (db) => {
          const row = {
            id: randomUUID(),
            userId: input.userId,
            organisationId: input.organisationId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            createdAt: new Date(),
            revokedAt: null,
          };
          await db.insert(sessions).values(row);
          return row;
        });
      },
      async findActiveByHash(tokenHash: string, now = new Date()) {
        const session = await lookupSessionByHash(db, tokenHash);
        if (!session || session.revokedAt || session.expiresAt <= now) {
          return null;
        }
        return session;
      },
      async revoke(organisationId: string, sessionId: string) {
        requireOrganisationId(organisationId);
        await usingTenant(db, organisationId, async (tx) => {
          await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.organisationId, organisationId), eq(sessions.id, sessionId)));
        });
      },
    },
    passwordResets: {
      async create(input: { organisationId: string; userId: string; tokenHash: string; expiresAt: Date }) {
        requireOrganisationId(input.organisationId);
        const row = {
          id: randomUUID(),
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          usedAt: null,
          createdAt: new Date(),
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(passwordResetTokens).values(row);
        });
        return row;
      },
      async findValid(tokenHash: string, now = new Date()) {
        const token = await lookupPasswordReset(db, tokenHash);
        if (!token || token.usedAt || token.expiresAt <= now) {
          return null;
        }
        return token;
      },
      async markUsed(organisationId: string, id: string) {
        requireOrganisationId(organisationId);
        await usingTenant(db, organisationId, async (tx) => {
          await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, id));
        });
      },
    },
    environments: {
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(environments)
            .where(eq(environments.organisationId, organisationId))
            .orderBy(environments.createdAt);
        });
      },
      async findById(organisationId: string, environmentId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select()
            .from(environments)
            .where(and(eq(environments.organisationId, organisationId), eq(environments.id, environmentId)))
            .limit(1);
          return rows[0] ?? null;
        });
      },
      async create(input: { organisationId: string; name: string; type: EnvironmentType }) {
        requireOrganisationId(input.organisationId);
        return usingTenant(db, input.organisationId, async (db) => {
          const base = slugify(input.name);
          const existing = await this.list(input.organisationId);
          let slug = base;
          let suffix = 2;
          while (existing.some((environment) => environment.slug === slug)) {
            slug = `${base}-${suffix++}`;
          }
          const row = {
            id: randomUUID(),
            organisationId: input.organisationId,
            name: input.name,
            slug,
            type: input.type,
            createdAt: new Date(),
          };
          await db.insert(environments).values(row);
          return row;
        });
      },
    },
    aiSystems: {
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(aiSystems)
            .where(eq(aiSystems.organisationId, organisationId))
            .orderBy(aiSystems.name);
        });
      },
      async findById(organisationId: string, aiSystemId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select()
            .from(aiSystems)
            .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, aiSystemId)))
            .limit(1);
          return rows[0] ?? null;
        });
      },
      async setStatus(organisationId: string, aiSystemId: string, status: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          await db
            .update(aiSystems)
            .set({ status, updatedAt: new Date() })
            .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, aiSystemId)));
        });
      },
      async touch(organisationId: string, aiSystemId: string, at: Date) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          await db
            .update(aiSystems)
            .set({ lastActivityAt: at, updatedAt: at })
            .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, aiSystemId)));
        });
      },
    },
    apiKeys: {
      async list(organisationId: string, aiSystemId?: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select({
              id: virtualApiKeys.id,
              organisationId: virtualApiKeys.organisationId,
              aiSystemId: virtualApiKeys.aiSystemId,
              environmentId: virtualApiKeys.environmentId,
              name: virtualApiKeys.name,
              keyPrefix: virtualApiKeys.keyPrefix,
              status: virtualApiKeys.status,
              createdAt: virtualApiKeys.createdAt,
              expiresAt: virtualApiKeys.expiresAt,
              lastUsedAt: virtualApiKeys.lastUsedAt,
              revokedAt: virtualApiKeys.revokedAt,
            })
            .from(virtualApiKeys)
            .where(
              aiSystemId
                ? and(
                    eq(virtualApiKeys.organisationId, organisationId),
                    eq(virtualApiKeys.aiSystemId, aiSystemId),
                  )
                : eq(virtualApiKeys.organisationId, organisationId),
            )
            .orderBy(desc(virtualApiKeys.createdAt));
        });
      },
      async findById(organisationId: string, keyId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select()
            .from(virtualApiKeys)
            .where(and(eq(virtualApiKeys.organisationId, organisationId), eq(virtualApiKeys.id, keyId)))
            .limit(1);
          return rows[0] ?? null;
        });
      },
      async insert(input: {
        organisationId: string;
        aiSystemId: string;
        environmentId: string;
        name: string;
        environmentType: EnvironmentType;
      }) {
        requireOrganisationId(input.organisationId);
        const generated = generateVirtualApiKey(input.environmentType);
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId,
          environmentId: input.environmentId,
          name: input.name,
          keyPrefix: generated.keyPrefix,
          keyHash: generated.keyHash,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(virtualApiKeys).values(row);
        });
        return { record: row, rawKey: generated.rawKey };
      },
      async revoke(organisationId: string, keyId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const existing = await this.findById(organisationId, keyId);
          if (!existing) {
            return null;
          }
          await db
            .update(virtualApiKeys)
            .set({ status: 'revoked', revokedAt: new Date() })
            .where(and(eq(virtualApiKeys.organisationId, organisationId), eq(virtualApiKeys.id, keyId)));
          return existing;
        });
      },
      async markUsed(organisationId: string, keyId: string, at: Date) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          await db
            .update(virtualApiKeys)
            .set({ lastUsedAt: at })
            .where(and(eq(virtualApiKeys.organisationId, organisationId), eq(virtualApiKeys.id, keyId)));
        });
      },
    },
    providerConnections: {
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select({
              id: providerConnections.id,
              organisationId: providerConnections.organisationId,
              environmentId: providerConnections.environmentId,
              provider: providerConnections.provider,
              name: providerConnections.name,
              status: providerConnections.status,
              credentialSource: providerConnections.credentialSource,
              credentialRef: providerConnections.credentialRef,
              verificationStatus: providerConnections.verificationStatus,
              verificationErrorCode: providerConnections.verificationErrorCode,
              verifiedAt: providerConnections.verifiedAt,
              lastCheckedAt: providerConnections.lastCheckedAt,
              createdAt: providerConnections.createdAt,
              updatedAt: providerConnections.updatedAt,
            })
            .from(providerConnections)
            .where(eq(providerConnections.organisationId, organisationId));
        });
      },
      async findActive(organisationId: string, environmentId: string, provider: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select()
            .from(providerConnections)
            .where(
              and(
                eq(providerConnections.organisationId, organisationId),
                eq(providerConnections.environmentId, environmentId),
                eq(providerConnections.provider, provider),
                eq(providerConnections.status, 'active'),
              ),
            )
            .orderBy(desc(providerConnections.updatedAt))
            .limit(1);
          return rows[0] ?? null;
        });
      },
      async create(input: {
        organisationId: string;
        environmentId: string;
        provider: string;
        name: string;
        credentialSource: 'platform_env' | 'customer_managed' | 'organisation' | 'vhalcha_managed';
        credentialRef?: string | null;
      }) {
        requireOrganisationId(input.organisationId);
        if (input.credentialSource === 'customer_managed') {
          throw new Error('Customer-managed provider credentials require a key management service.');
        }
        const now = new Date();
        const credentialRef =
          input.credentialRef ??
          (input.provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : input.provider === 'google'
              ? 'GOOGLE_API_KEY'
              : 'OPENAI_API_KEY');
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          environmentId: input.environmentId,
          provider: input.provider,
          name: input.name,
          status: 'active',
          credentialSource: input.credentialSource,
          credentialRef,
          encryptedCredentials: null,
          verificationStatus: input.credentialSource === 'platform_env' ? 'verified' : 'unverified',
          createdAt: now,
          updatedAt: now,
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx
            .update(providerConnections)
            .set({ status: 'disabled', updatedAt: now })
            .where(
              and(
                eq(providerConnections.organisationId, input.organisationId),
                eq(providerConnections.environmentId, input.environmentId),
                eq(providerConnections.provider, input.provider),
                eq(providerConnections.status, 'active'),
              ),
            );
          await tx.insert(providerConnections).values(row);
        });
        return row;
      },
      async connectOrganisation(input: {
        organisationId: string;
        environmentId: string;
        provider: string;
        name: string;
        encryptedCredentials: string;
      }) {
        requireOrganisationId(input.organisationId);
        const now = new Date();
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          environmentId: input.environmentId,
          provider: input.provider,
          name: input.name,
          status: 'active',
          credentialSource: 'organisation',
          credentialRef: null,
          encryptedCredentials: input.encryptedCredentials,
          verificationStatus: 'unverified',
          createdAt: now,
          updatedAt: now,
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx
            .update(providerConnections)
            .set({ status: 'disabled', updatedAt: now })
            .where(
              and(
                eq(providerConnections.organisationId, input.organisationId),
                eq(providerConnections.environmentId, input.environmentId),
                eq(providerConnections.provider, input.provider),
                eq(providerConnections.status, 'active'),
              ),
            );
          await tx.insert(providerConnections).values(row);
        });
        return { id: row.id, provider: row.provider, name: row.name, credentialSource: row.credentialSource, status: row.status };
      },
      async setVerification(
        organisationId: string,
        connectionId: string,
        input: {
          verificationStatus: 'unverified' | 'verified' | 'failed';
          verificationErrorCode?: string | null;
          verifiedAt?: Date | null;
          lastCheckedAt: Date;
        },
      ) {
        requireOrganisationId(organisationId);
        await usingTenant(db, organisationId, async (tx) => {
          await tx
            .update(providerConnections)
            .set({
              verificationStatus: input.verificationStatus,
              verificationErrorCode: input.verificationErrorCode ?? null,
              verifiedAt: input.verifiedAt ?? null,
              lastCheckedAt: input.lastCheckedAt,
              updatedAt: input.lastCheckedAt,
            })
            .where(and(eq(providerConnections.organisationId, organisationId), eq(providerConnections.id, connectionId)));
        });
      },
      async setStatus(organisationId: string, connectionId: string, status: 'active' | 'disabled') {
        requireOrganisationId(organisationId);
        await usingTenant(db, organisationId, async (tx) => {
          await tx
            .update(providerConnections)
            .set({ status, updatedAt: new Date() })
            .where(and(eq(providerConnections.organisationId, organisationId), eq(providerConnections.id, connectionId)));
        });
      },
    },
    modelAccess: {
      async listForSystem(organisationId: string, aiSystemId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(modelAccessRules)
            .where(
              and(
                eq(modelAccessRules.organisationId, organisationId),
                eq(modelAccessRules.aiSystemId, aiSystemId),
              ),
            );
        });
      },
      async create(input: {
        organisationId: string;
        aiSystemId: string;
        provider: string;
        modelPattern: string;
        isAllowed: boolean;
        priority?: number;
      }) {
        requireOrganisationId(input.organisationId);
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId,
          provider: input.provider,
          modelPattern: input.modelPattern,
          isAllowed: input.isAllowed,
          priority: input.priority ?? 100,
          createdAt: new Date(),
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(modelAccessRules).values(row);
        });
        return row;
      },
    },
    budgets: {
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db.select().from(budgets).where(eq(budgets.organisationId, organisationId));
        });
      },
      async applicable(organisationId: string, aiSystemId: string, environmentId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db.select().from(budgets).where(eq(budgets.organisationId, organisationId));
          return rows.filter((budget) => {
            const systemMatch = budget.aiSystemId === null || budget.aiSystemId === aiSystemId;
            const environmentMatch = budget.environmentId === null || budget.environmentId === environmentId;
            return systemMatch && environmentMatch;
          });
        });
      },
      async create(input: {
        organisationId: string;
        aiSystemId?: string | null;
        environmentId?: string | null;
        name: string;
        period: 'daily' | 'monthly';
        amountUsd: number;
        warningThresholdPercent?: number;
        hardLimit: boolean;
        action: 'notify' | 'block';
      }) {
        requireOrganisationId(input.organisationId);
        const now = new Date();
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId ?? null,
          environmentId: input.environmentId ?? null,
          name: input.name,
          period: input.period,
          amountUsd: toNumeric(input.amountUsd),
          warningThresholdPercent: input.warningThresholdPercent ?? 80,
          hardLimit: input.hardLimit,
          action: input.action,
          createdAt: now,
          updatedAt: now,
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(budgets).values(row);
          if (input.aiSystemId && input.period === 'monthly') {
            await tx
              .update(aiSystems)
              .set({ monthlyBudgetUsd: toNumeric(input.amountUsd), updatedAt: now })
              .where(
                and(eq(aiSystems.organisationId, input.organisationId), eq(aiSystems.id, input.aiSystemId)),
              );
          }
        });
        return row;
      },
      async update(
        organisationId: string,
        budgetId: string,
        patch: { amountUsd?: number; warningThresholdPercent?: number; hardLimit?: boolean; action?: 'notify' | 'block' },
      ) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
        const existing = await db
          .select()
          .from(budgets)
          .where(and(eq(budgets.organisationId, organisationId), eq(budgets.id, budgetId)))
          .limit(1);
        const budget = existing[0];
        if (!budget) {
          return null;
        }
        const now = new Date();
        await db
          .update(budgets)
          .set({
            ...(patch.amountUsd !== undefined ? { amountUsd: toNumeric(patch.amountUsd) } : {}),
            ...(patch.warningThresholdPercent !== undefined
              ? { warningThresholdPercent: patch.warningThresholdPercent }
              : {}),
            ...(patch.hardLimit !== undefined ? { hardLimit: patch.hardLimit } : {}),
            ...(patch.action !== undefined ? { action: patch.action } : {}),
            updatedAt: now,
          })
          .where(and(eq(budgets.organisationId, organisationId), eq(budgets.id, budgetId)));
        if (budget.aiSystemId && budget.period === 'monthly' && patch.amountUsd !== undefined) {
          await db
            .update(aiSystems)
            .set({ monthlyBudgetUsd: toNumeric(patch.amountUsd), updatedAt: now })
            .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, budget.aiSystemId)));
        }
        return budget;
        });
      },
    },
    requests: {
      async create(input: {
        id?: string;
        organisationId: string;
        aiSystemId: string;
        environmentId: string;
        virtualApiKeyId: string;
        provider: string;
        model: string;
        status: string;
        policyResult: string;
        startedAt: Date;
        httpStatus?: number | null;
        errorCode?: string | null;
        errorMessageSafe?: string | null;
        completedAt?: Date | null;
      }) {
        requireOrganisationId(input.organisationId);
        const row = {
          id: input.id ?? randomUUID(),
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId,
          environmentId: input.environmentId,
          virtualApiKeyId: input.virtualApiKeyId,
          provider: input.provider,
          model: input.model,
          status: input.status,
          httpStatus: input.httpStatus ?? null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          estimatedCostUsd: null,
          latencyMs: null,
          providerLatencyMs: null,
          timeToFirstTokenMs: null,
          policyResult: input.policyResult,
          errorCode: input.errorCode ?? null,
          errorMessageSafe: input.errorMessageSafe ?? null,
          startedAt: input.startedAt,
          completedAt: input.completedAt ?? null,
          createdAt: input.startedAt,
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(requests).values(row);
        });
        return row;
      },
      async markProviderStarted(organisationId: string, requestId: string) {
        requireOrganisationId(organisationId);
        await usingTenant(db, organisationId, async (tx) => {
          await tx
            .update(requests)
            .set({ status: 'provider_started' })
            .where(
              and(
                eq(requests.organisationId, organisationId),
                eq(requests.id, requestId),
                eq(requests.status, 'pending'),
              ),
            );
        });
      },
      async complete(
        organisationId: string,
        requestId: string,
        patch: {
          status: string;
          httpStatus?: number | null;
          inputTokens?: number | null;
          outputTokens?: number | null;
          totalTokens?: number | null;
          estimatedCostUsd?: string | null;
          latencyMs?: number | null;
          providerLatencyMs?: number | null;
          timeToFirstTokenMs?: number | null;
          policyResult?: string;
          errorCode?: string | null;
        errorMessageSafe?: string | null;
        provider?: string;
        model?: string;
        completedAt: Date;
      },
      ) {
        requireOrganisationId(organisationId);
        await usingTenant(db, organisationId, async (tx) => {
          await tx
            .update(requests)
            .set(patch)
            .where(and(eq(requests.organisationId, organisationId), eq(requests.id, requestId)));
        });
      },
      async findById(organisationId: string, requestId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select()
            .from(requests)
            .where(and(eq(requests.organisationId, organisationId), eq(requests.id, requestId)))
            .limit(1);
          return rows[0] ?? null;
        });
      },
      async list(organisationId: string, start: Date, end: Date, limit = 100) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(requests)
            .where(
              and(
                eq(requests.organisationId, organisationId),
                gte(requests.createdAt, start),
                lt(requests.createdAt, end),
              ),
            )
            .orderBy(desc(requests.createdAt))
            .limit(limit);
        });
      },
    },
    usage: {
      async create(input: {
        organisationId: string;
        aiSystemId: string;
        requestId: string;
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        costUsd: number | null;
      }) {
        requireOrganisationId(input.organisationId);
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId,
          requestId: input.requestId,
          provider: input.provider,
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          totalTokens: input.totalTokens,
          costUsd: input.costUsd === null ? null : toNumeric(input.costUsd, 8),
          createdAt: new Date(),
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(usageEvents).values(row);
        });
        return row;
      },
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db.select().from(usageEvents).where(eq(usageEvents.organisationId, organisationId));
        });
      },
      async sumCost(organisationId: string, aiSystemId: string, start: Date, end: Date) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select({
              total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
            })
            .from(usageEvents)
            .where(
              and(
                eq(usageEvents.organisationId, organisationId),
                eq(usageEvents.aiSystemId, aiSystemId),
                gte(usageEvents.createdAt, start),
                lt(usageEvents.createdAt, end),
              ),
            );
          return toNumber(rows[0]?.total);
        });
      },
      async sumOrganisationCost(organisationId: string, start: Date, end: Date) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const rows = await db
            .select({
              total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
            })
            .from(usageEvents)
            .where(
              and(
                eq(usageEvents.organisationId, organisationId),
                gte(usageEvents.createdAt, start),
                lt(usageEvents.createdAt, end),
              ),
            );
          return toNumber(rows[0]?.total);
        });
      },
      async sumEnvironmentCost(organisationId: string, environmentId: string, start: Date, end: Date) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          const result = await db.execute<{ total: string }>(sql`
            select coalesce(sum(ue.cost_usd), 0)::text as total
            from usage_events ue
            inner join requests r on r.id = ue.request_id and r.organisation_id = ue.organisation_id
            where ue.organisation_id = ${organisationId}
              and r.environment_id = ${environmentId}
              and ue.created_at >= ${start}
              and ue.created_at < ${end}
          `);
          const rows = Array.isArray(result)
            ? result
            : (result as { rows?: Array<{ total?: string }> }).rows ?? [];
          return toNumber(rows[0]?.total);
        });
      },
    },
    audit: {
      async create(organisationId: string, draft: AuditDraft) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          if (draft.organisationId !== organisationId) {
            throw new Error('Audit organisation does not match the repository scope.');
          }
          const row = {
            id: randomUUID(),
            organisationId,
            environmentId: draft.environmentId ?? null,
            actorType: draft.actorType,
            actorId: draft.actorId ?? null,
            action: draft.action,
            resourceType: draft.resourceType,
            resourceId: draft.resourceId ?? null,
            result: draft.result,
            severity: draft.severity,
            requestId: draft.requestId ?? null,
            metadataJson: safeAuditMetadata(draft.metadata),
            createdAt: new Date(),
          };
          await db.insert(auditEvents).values(row);
          return row;
        });
      },
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.organisationId, organisationId))
            .orderBy(desc(auditEvents.createdAt));
        });
      },
      async listForRequest(organisationId: string, requestId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(auditEvents)
            .where(and(eq(auditEvents.organisationId, organisationId), eq(auditEvents.requestId, requestId)))
            .orderBy(auditEvents.createdAt);
        });
      },
    },
    policyEvents: {
      async create(input: {
        organisationId: string;
        aiSystemId: string;
        requestId?: string | null;
        policyType: string;
        policyName: string;
        result: 'allowed' | 'warning' | 'blocked';
        severity: 'info' | 'warning' | 'critical';
        details?: Record<string, unknown>;
      }) {
        requireOrganisationId(input.organisationId);
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId,
          requestId: input.requestId ?? null,
          policyType: input.policyType,
          policyName: input.policyName,
          result: input.result,
          severity: input.severity,
          detailsJson: safeAuditMetadata(input.details),
          createdAt: new Date(),
        };
        await usingTenant(db, input.organisationId, async (tx) => {
          await tx.insert(policyEvents).values(row);
        });
        return row;
      },
      async list(organisationId: string, limit = 20) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(policyEvents)
            .where(eq(policyEvents.organisationId, organisationId))
            .orderBy(desc(policyEvents.createdAt))
            .limit(limit);
        });
      },
      async listForRequest(organisationId: string, requestId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(policyEvents)
            .where(and(eq(policyEvents.organisationId, organisationId), eq(policyEvents.requestId, requestId)));
        });
      },
    },
    spendSummaries: {
      async upsert(input: {
        organisationId: string;
        aiSystemId: string;
        provider: string;
        model: string;
        period: 'daily' | 'monthly';
        periodStart: Date;
        totalCostUsd: number;
        totalRequests: number;
        totalTokens: number;
      }) {
        requireOrganisationId(input.organisationId);
        return usingTenant(db, input.organisationId, async (db) => {
        const existing = await db
          .select()
          .from(spendSummaries)
          .where(
            and(
              eq(spendSummaries.organisationId, input.organisationId),
              eq(spendSummaries.aiSystemId, input.aiSystemId),
              eq(spendSummaries.provider, input.provider),
              eq(spendSummaries.model, input.model),
              eq(spendSummaries.period, input.period),
              eq(spendSummaries.periodStart, input.periodStart),
            ),
          )
          .limit(1);
        const now = new Date();
        const current = existing[0];
        if (current) {
          await db
            .update(spendSummaries)
            .set({
              totalCostUsd: toNumeric(input.totalCostUsd, 8),
              totalRequests: input.totalRequests,
              totalTokens: input.totalTokens,
              updatedAt: now,
            })
            .where(eq(spendSummaries.id, current.id));
          return current.id;
        }
        const id = randomUUID();
        await db.insert(spendSummaries).values({
          id,
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId,
          provider: input.provider,
          model: input.model,
          period: input.period,
          periodStart: input.periodStart,
          totalCostUsd: toNumeric(input.totalCostUsd, 8),
          totalRequests: input.totalRequests,
          totalTokens: input.totalTokens,
          createdAt: now,
          updatedAt: now,
        });
        return id;
        });
      },
    },
    budgetReservations: {
      async list(organisationId: string) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          return db
            .select()
            .from(budgetReservations)
            .where(eq(budgetReservations.organisationId, organisationId))
            .orderBy(desc(budgetReservations.createdAt));
        });
      },
      async reserve(input: {
        organisationId: string;
        aiSystemId: string;
        environmentId: string;
        requestId: string;
        estimatedUsd: number;
        now: Date;
        expiresAt: Date;
        periods: { budgetId: string; start: Date; end: Date }[];
      }) {
        requireOrganisationId(input.organisationId);
        return usingTenant(db, input.organisationId, async (tx) => {
          const scoped = createRepositories(tx as unknown as AppDatabase);
          const applicable = await scoped.budgets.applicable(
            input.organisationId,
            input.aiSystemId,
            input.environmentId,
          );
          const blocking = applicable.filter((budget) => isBlockingBudget(budget));
          await lockBudgetRows(tx, input.organisationId, blocking.map((budget) => budget.id));
          const snapshots: Array<{
            id: string;
            name: string;
            period: 'daily' | 'monthly';
            amountUsd: number;
            warningThresholdPercent: number;
            hardLimit: boolean;
            action: 'notify' | 'block';
            spendUsd: number;
            scope: 'organisation' | 'environment' | 'ai_system';
          }> = [];
          for (const budget of applicable) {
            const period = input.periods.find((item) => item.budgetId === budget.id);
            if (!period) {
              throw new Error('Budget period window was not provided.');
            }
            const committed = await committedForBudget(scoped, input.organisationId, budget, period);
            const held = await activeHoldUsd(tx, input.organisationId, budget.id, input.now);
            const amountUsd = toNumber(budget.amountUsd);
            const blocks = isBlockingBudget(budget);
            const projected = committed + held + input.estimatedUsd;
            if (
              blocks &&
              (toMicroUsd(committed + held) >= toMicroUsd(amountUsd) ||
                toMicroUsd(projected) > toMicroUsd(amountUsd))
            ) {
              throw new BudgetReservationRejected({
                budgetId: budget.id,
                budgetName: budget.name,
                spendUsd: committed + held,
                amountUsd,
              });
            }
            snapshots.push({
              id: budget.id,
              name: budget.name,
              period: budget.period === 'daily' ? 'daily' : 'monthly',
              amountUsd,
              warningThresholdPercent: budget.warningThresholdPercent,
              hardLimit: budget.hardLimit,
              action: budget.action === 'block' ? 'block' : 'notify',
              spendUsd: projected,
              scope: budget.aiSystemId ? 'ai_system' : budget.environmentId ? 'environment' : 'organisation',
            });
          }
          for (const budget of blocking) {
            await tx.insert(budgetReservations).values({
              id: randomUUID(),
              organisationId: input.organisationId,
              aiSystemId: input.aiSystemId,
              requestId: input.requestId,
              budgetId: budget.id,
              reservedUsd: toNumeric(input.estimatedUsd, 8),
              actualUsd: null,
              status: 'reserved',
              expiresAt: input.expiresAt,
              createdAt: input.now,
              finalizedAt: null,
            });
          }
          return { estimatedUsd: input.estimatedUsd, snapshots };
        });
      },
      async release(organisationId: string, requestId: string, now: Date) {
        requireOrganisationId(organisationId);
        return usingTenant(db, organisationId, async (db) => {
          await db
            .update(budgetReservations)
            .set({ status: 'released', actualUsd: toNumeric(0, 8), finalizedAt: now })
            .where(
              and(
                eq(budgetReservations.organisationId, organisationId),
                eq(budgetReservations.requestId, requestId),
                eq(budgetReservations.status, 'reserved'),
              ),
            );
        });
      },
      async headroom(input: {
        organisationId: string;
        aiSystemId: string;
        environmentId: string;
        now: Date;
        periods: { budgetId: string; start: Date; end: Date }[];
      }): Promise<number | null> {
        requireOrganisationId(input.organisationId);
        return usingTenant(db, input.organisationId, async (tx) => {
          const scoped = createRepositories(tx as unknown as AppDatabase);
          const applicable = await scoped.budgets.applicable(input.organisationId, input.aiSystemId, input.environmentId);
          const blocking = applicable.filter((budget) => isBlockingBudget(budget));
          if (blocking.length === 0) {
            return null;
          }
          await lockBudgetRows(tx, input.organisationId, blocking.map((budget) => budget.id));
          let remaining = Number.POSITIVE_INFINITY;
          for (const budget of blocking) {
            const period = input.periods.find((item) => item.budgetId === budget.id);
            if (!period) {
              throw new Error('Budget period window was not provided.');
            }
            const committed = await committedForBudget(scoped, input.organisationId, budget, period);
            const held = await activeHoldUsd(tx, input.organisationId, budget.id, input.now);
            remaining = Math.min(remaining, toNumber(budget.amountUsd) - committed - held);
          }
          return Math.max(0, remaining);
        });
      },
      async raise(input: {
        organisationId: string;
        aiSystemId: string;
        environmentId: string;
        requestId: string;
        estimatedUsd: number;
        now: Date;
        periods: { budgetId: string; start: Date; end: Date }[];
      }) {
        requireOrganisationId(input.organisationId);
        return usingTenant(db, input.organisationId, async (tx) => {
          const current = await tx
            .select()
            .from(budgetReservations)
            .where(
              and(
                eq(budgetReservations.organisationId, input.organisationId),
                eq(budgetReservations.requestId, input.requestId),
                eq(budgetReservations.status, 'reserved'),
              ),
            )
            .for('update');
          const currentReserved = current.reduce((sum, row) => Math.max(sum, toNumber(row.reservedUsd)), 0);
          if (input.estimatedUsd <= currentReserved) {
            return { estimatedUsd: currentReserved };
          }
          const scoped = createRepositories(tx as unknown as AppDatabase);
          const applicable = await scoped.budgets.applicable(input.organisationId, input.aiSystemId, input.environmentId);
          const blocking = applicable.filter((item) => isBlockingBudget(item));
          await lockBudgetRows(tx, input.organisationId, blocking.map((budget) => budget.id));
          for (const budget of blocking) {
            const period = input.periods.find((item) => item.budgetId === budget.id);
            if (!period) {
              throw new Error('Budget period window was not provided.');
            }
            const committed = await committedForBudget(scoped, input.organisationId, budget, period);
            const held = await activeHoldUsd(tx, input.organisationId, budget.id, input.now);
            const amountUsd = toNumber(budget.amountUsd);
            const projected = committed + held - currentReserved + input.estimatedUsd;
            if (toMicroUsd(projected) > toMicroUsd(amountUsd)) {
              throw new BudgetReservationRejected({
                budgetId: budget.id,
                budgetName: budget.name,
                spendUsd: committed + held,
                amountUsd,
              });
            }
          }
          await tx
            .update(budgetReservations)
            .set({ reservedUsd: toNumeric(input.estimatedUsd, 8) })
            .where(
              and(
                eq(budgetReservations.organisationId, input.organisationId),
                eq(budgetReservations.requestId, input.requestId),
                eq(budgetReservations.status, 'reserved'),
              ),
            );
          return { estimatedUsd: input.estimatedUsd };
        });
      },
      async expireDue(now: Date) {
        const due = await db
          .select()
          .from(budgetReservations)
          .where(and(eq(budgetReservations.status, 'reserved'), lt(budgetReservations.expiresAt, now)));
        const groups = new Map<string, typeof due>();
        for (const hold of due) {
          const current = groups.get(hold.requestId) ?? [];
          current.push(hold);
          groups.set(hold.requestId, current);
        }
        let processed = 0;
        for (const [requestId, holds] of groups) {
          const organisationId = holds[0]?.organisationId;
          if (!organisationId) {
            continue;
          }
          await usingTenant(db, organisationId, async (tx) => {
            const requestRows = await tx
              .select()
              .from(requests)
              .where(and(eq(requests.organisationId, organisationId), eq(requests.id, requestId)))
              .limit(1);
            const request = requestRows[0];
            const usageRows = await tx
              .select()
              .from(usageEvents)
              .where(and(eq(usageEvents.organisationId, organisationId), eq(usageEvents.requestId, requestId)))
              .limit(1);
            const providerMayHaveRun =
              request !== undefined &&
              (request.status === 'provider_started' ||
                request.status === 'streaming' ||
                request.status === 'reconciliation_required');
            if (providerMayHaveRun && usageRows.length === 0) {
              const reserved = toNumber(holds[0]?.reservedUsd);
              await tx.insert(usageEvents).values({
                id: randomUUID(),
                organisationId,
                aiSystemId: request.aiSystemId,
                requestId,
                provider: request.provider,
                model: request.model,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                costUsd: toNumeric(reserved, 8),
                createdAt: now,
              });
              for (const hold of holds) {
                await tx
                  .update(budgetReservations)
                  .set({ status: 'finalized', actualUsd: hold.reservedUsd, finalizedAt: now })
                  .where(eq(budgetReservations.id, hold.id));
              }
              await tx
                .update(requests)
                .set({
                  status: 'reconciliation_required',
                  errorCode: 'reconciliation_required',
                  errorMessageSafe:
                    'Provider completion was not recorded. The reserved amount is kept until the request is reconciled.',
                  completedAt: now,
                })
                .where(and(eq(requests.organisationId, organisationId), eq(requests.id, requestId)));
              await tx.insert(auditEvents).values({
                id: randomUUID(),
                organisationId,
                environmentId: request.environmentId,
                actorType: 'system',
                actorId: null,
                action: auditActions.budgetReconciliationRequired,
                resourceType: 'request',
                resourceId: requestId,
                result: 'success',
                severity: 'warning',
                requestId,
                metadataJson: safeAuditMetadata({ reserved_usd: reserved, ai_system_id: request.aiSystemId }),
                createdAt: now,
              });
            } else if (usageRows.length > 0) {
              const actual = usageRows[0]?.costUsd ?? null;
              for (const hold of holds) {
                await tx
                  .update(budgetReservations)
                  .set({ status: 'finalized', actualUsd: actual, finalizedAt: now })
                  .where(eq(budgetReservations.id, hold.id));
              }
            } else {
              for (const hold of holds) {
                await tx
                  .update(budgetReservations)
                  .set({ status: 'expired', finalizedAt: now })
                  .where(eq(budgetReservations.id, hold.id));
              }
            }
          });
          processed += holds.length;
        }
        return processed;
      },
    },
    async finalizeGatewayRequest(input: {
      organisationId: string;
      requestId: string;
      aiSystemId: string;
      virtualApiKeyId: string;
      completedAt: Date;
      requestPatch: {
        status: string;
        httpStatus?: number | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        totalTokens?: number | null;
        estimatedCostUsd?: string | null;
        latencyMs?: number | null;
        providerLatencyMs?: number | null;
        timeToFirstTokenMs?: number | null;
        policyResult?: string;
        errorCode?: string | null;
        errorMessageSafe?: string | null;
        provider?: string;
        model?: string;
      };
      usage: {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        costUsd: number | null;
        pricingKnown: boolean;
      } | null;
      audit: AuditDraft;
    }) {
      requireOrganisationId(input.organisationId);
      return usingTenant(db, input.organisationId, async (tx) => {
        const scoped = createRepositories(tx as unknown as AppDatabase);
        const locked = await tx
          .select()
          .from(requests)
          .where(and(eq(requests.organisationId, input.organisationId), eq(requests.id, input.requestId)))
          .for('update');
        const request = locked[0];
        if (!request) {
          throw new Error('Gateway request was not found.');
        }
        const existingUsage = await tx
          .select()
          .from(usageEvents)
          .where(
            and(eq(usageEvents.organisationId, input.organisationId), eq(usageEvents.requestId, input.requestId)),
          );
        const terminal = request.status === 'succeeded' || request.status === 'failed' || request.status === 'blocked';
        if (existingUsage.length > 0 && terminal) {
          return { duplicate: true, overrun: false, reservedUsd: 0, actualUsd: toNumber(existingUsage[0]?.costUsd) };
        }
        if (existingUsage.length === 0 && input.usage) {
          await scoped.usage.create({
            organisationId: input.organisationId,
            aiSystemId: input.aiSystemId,
            requestId: input.requestId,
            provider: input.usage.provider,
            model: input.usage.model,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            costUsd: input.usage.costUsd,
          });
        } else if (existingUsage[0] && input.usage && request.status === 'reconciliation_required') {
          await tx
            .update(usageEvents)
            .set({
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
              totalTokens: input.usage.totalTokens,
              costUsd: input.usage.costUsd === null ? null : toNumeric(input.usage.costUsd, 8),
            })
            .where(eq(usageEvents.id, existingUsage[0].id));
        }
        if (!terminal) {
          await scoped.requests.complete(input.organisationId, input.requestId, {
            ...input.requestPatch,
            completedAt: input.completedAt,
          });
        }
        const holds = await tx
          .select()
          .from(budgetReservations)
          .where(
            and(
              eq(budgetReservations.organisationId, input.organisationId),
              eq(budgetReservations.requestId, input.requestId),
              inArray(budgetReservations.status, ['reserved', 'expired', 'finalized']),
            ),
          )
          .for('update');
        const actualUsd = input.usage?.costUsd ?? null;
        let overrun = false;
        let reservedUsd = 0;
        for (const hold of holds) {
          const reserved = toNumber(hold.reservedUsd);
          reservedUsd += reserved;
          if (input.usage) {
            if (actualUsd !== null && toMicroUsd(actualUsd) > toMicroUsd(reserved)) {
              overrun = true;
            }
            await tx
              .update(budgetReservations)
              .set({
                status: 'finalized',
                actualUsd: actualUsd === null ? null : toNumeric(actualUsd, 8),
                finalizedAt: input.completedAt,
              })
              .where(eq(budgetReservations.id, hold.id));
          } else if (hold.status === 'reserved') {
            await tx
              .update(budgetReservations)
              .set({ status: 'released', actualUsd: toNumeric(0, 8), finalizedAt: input.completedAt })
              .where(eq(budgetReservations.id, hold.id));
          }
        }
        const priorAudits = await scoped.audit.listForRequest(input.organisationId, input.requestId);
        if (!priorAudits.some((event) => event.action === input.audit.action)) {
          await scoped.audit.create(input.organisationId, input.audit);
        }
        if (overrun && !priorAudits.some((event) => event.action === auditActions.budgetReservationOverrun)) {
          await scoped.policyEvents.create({
            organisationId: input.organisationId,
            aiSystemId: input.aiSystemId,
            requestId: input.requestId,
            policyType: 'budget',
            policyName: 'Reservation reconciliation',
            result: 'warning',
            severity: 'warning',
            details: { reserved_usd: reservedUsd, actual_usd: actualUsd },
          });
          await scoped.audit.create(input.organisationId, {
            organisationId: input.organisationId,
            environmentId: input.audit.environmentId,
            actorType: 'system',
            actorId: input.virtualApiKeyId,
            action: auditActions.budgetReservationOverrun,
            resourceType: 'request',
            resourceId: input.requestId,
            result: 'success',
            severity: 'warning',
            requestId: input.requestId,
            metadata: { reserved_usd: reservedUsd, actual_usd: actualUsd, ai_system_id: input.aiSystemId },
          });
        }
        if (input.usage && !input.usage.pricingKnown) {
          await scoped.policyEvents.create({
            organisationId: input.organisationId,
            aiSystemId: input.aiSystemId,
            requestId: input.requestId,
            policyType: 'pricing',
            policyName: 'Known model price',
            result: 'warning',
            severity: 'warning',
            details: { pricing_unknown: true, model: input.usage.model },
          });
        }
        await scoped.aiSystems.touch(input.organisationId, input.aiSystemId, input.completedAt);
        await scoped.apiKeys.markUsed(input.organisationId, input.virtualApiKeyId, input.completedAt);
        return { duplicate: false, overrun, reservedUsd, actualUsd };
      });
    },
    async registerAiSystem(input: {
      organisationId: string;
      name: string;
      description: string;
      type: string;
      environmentId: string;
      riskLevel: string;
      monthlyBudgetUsd: number;
      modelPattern: string;
      requestsPerMinute: number;
      ownerUserId?: string | null;
      generateKey: boolean;
      actorUserId?: string | null;
    }) {
      requireOrganisationId(input.organisationId);
      return usingTenant(db, input.organisationId, async (tx) => {
        const scoped = createRepositories(tx as unknown as AppDatabase);
        const environment = await scoped.environments.findById(input.organisationId, input.environmentId);
        if (!environment) {
          throw new Error('Environment was not found in this organisation.');
        }
        const existing = await scoped.aiSystems.list(input.organisationId);
        const base = slugify(input.name);
        let slug = base;
        let suffix = 2;
        while (existing.some((system) => system.slug === slug)) {
          slug = `${base}-${suffix++}`;
        }
        const now = new Date();
        const system = {
          id: randomUUID(),
          organisationId: input.organisationId,
          environmentId: input.environmentId,
          name: input.name,
          slug,
          description: input.description,
          type: input.type,
          ownerUserId: input.ownerUserId ?? null,
          status: 'active',
          riskLevel: input.riskLevel,
          monthlyBudgetUsd: toNumeric(input.monthlyBudgetUsd),
          dailyBudgetUsd: null,
          requestsPerMinute: input.requestsPerMinute,
          createdAt: now,
          updatedAt: now,
          lastActivityAt: null,
        };
        await tx.insert(aiSystems).values(system);
        const budget = await scoped.budgets.create({
          organisationId: input.organisationId,
          aiSystemId: system.id,
          name: `${input.name} monthly budget`,
          period: 'monthly',
          amountUsd: input.monthlyBudgetUsd,
          warningThresholdPercent: 80,
          hardLimit: true,
          action: 'block',
        });
        const rule = await scoped.modelAccess.create({
          organisationId: input.organisationId,
          aiSystemId: system.id,
          provider: 'openai',
          modelPattern: input.modelPattern,
          isAllowed: true,
          priority: 100,
        });
        const key = input.generateKey
          ? await scoped.apiKeys.insert({
              organisationId: input.organisationId,
              aiSystemId: system.id,
              environmentId: input.environmentId,
              name: `${input.name} key`,
              environmentType: environment.type as EnvironmentType,
            })
          : null;
        await scoped.audit.create(input.organisationId, {
          organisationId: input.organisationId,
          environmentId: input.environmentId,
          actorType: 'user',
          actorId: input.actorUserId ?? null,
          action: 'ai_system.created',
          resourceType: 'ai_system',
          resourceId: system.id,
          result: 'success',
          severity: 'info',
          metadata: { ai_system_id: system.id, model_pattern: input.modelPattern },
        });
        return { system, budget, rule, key };
      });
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
