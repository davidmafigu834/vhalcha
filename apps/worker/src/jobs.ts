import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { periodBounds } from '@vhalcha/budgets';
import {
  createRepositories,
  indexKnowledgeVersion,
  organisations,
  sessions,
  usageEvents,
  virtualApiKeys,
  type AppDatabase,
} from '@vhalcha/database';
import {
  createKnowledgeObjectStore,
  createEmbeddingProvider,
  embeddingModeFromEnv,
} from '@vhalcha/knowledge';

export interface SpendJob {
  type: 'daily_spend_summary' | 'monthly_spend_summary';
}

export interface CleanupJob {
  type: 'cleanup';
}

export interface KnowledgeIngestJob {
  type: 'knowledge.ingest';
  organisationId: string;
  documentVersionId: string;
  force?: boolean;
}

export type WorkerJob = SpendJob | CleanupJob | KnowledgeIngestJob;

export async function rebuildSpendSummaries(
  db: AppDatabase,
  period: 'daily' | 'monthly',
  now = new Date(),
) {
  const repos = createRepositories(db);
  const orgs = await db.select().from(organisations);
  let summaries = 0;
  for (const organisation of orgs) {
    const bounds = periodBounds(period, organisation.timezone, now);
    const rows = await db
      .select({
        aiSystemId: usageEvents.aiSystemId,
        provider: usageEvents.provider,
        model: usageEvents.model,
        totalCost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
        totalRequests: sql<number>`count(*)::int`,
        totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organisationId, organisation.id),
          gte(usageEvents.createdAt, bounds.start),
          lt(usageEvents.createdAt, bounds.end),
        ),
      )
      .groupBy(usageEvents.aiSystemId, usageEvents.provider, usageEvents.model);
    for (const row of rows) {
      await repos.spendSummaries.upsert({
        organisationId: organisation.id,
        aiSystemId: row.aiSystemId,
        provider: row.provider,
        model: row.model,
        period,
        periodStart: bounds.start,
        totalCostUsd: Number(row.totalCost),
        totalRequests: Number(row.totalRequests),
        totalTokens: Number(row.totalTokens),
      });
      summaries += 1;
    }
  }
  return summaries;
}

export async function cleanupExpiredRecords(db: AppDatabase, now = new Date()) {
  const removedSessions = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id });
  const expiredKeys = await db
    .update(virtualApiKeys)
    .set({ status: 'expired', revokedAt: now })
    .where(
      and(
        eq(virtualApiKeys.status, 'active'),
        isNotNull(virtualApiKeys.expiresAt),
        lt(virtualApiKeys.expiresAt, now),
      ),
    )
    .returning({ id: virtualApiKeys.id });
  const expiredReservations = await createRepositories(db).budgetReservations.expireDue(now);
  return { removedSessions: removedSessions.length, expiredKeys: expiredKeys.length, expiredReservations };
}

export async function runKnowledgeIngest(db: AppDatabase, job: KnowledgeIngestJob) {
  const embedder = createEmbeddingProvider({
    mode: embeddingModeFromEnv(),
    apiKey: process.env.OPENAI_API_KEY,
  });
  const store = await createKnowledgeObjectStore();
  return indexKnowledgeVersion(db, {
    organisationId: job.organisationId,
    documentVersionId: job.documentVersionId,
    embedder,
    store,
    force: job.force,
  });
}

export async function runWorkerJob(db: AppDatabase, job: WorkerJob, now = new Date()) {
  if (job.type === 'cleanup') {
    return cleanupExpiredRecords(db, now);
  }
  if (job.type === 'knowledge.ingest') {
    return runKnowledgeIngest(db, job);
  }
  const period = job.type === 'daily_spend_summary' ? 'daily' : 'monthly';
  return { summaries: await rebuildSpendSummaries(db, period, now) };
}
