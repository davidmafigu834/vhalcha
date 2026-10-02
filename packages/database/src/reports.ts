import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { AppDatabase } from './client';
import {
  aiSystems,
  auditEvents,
  environments,
  modelAccessRules,
  policyEvents,
  requests,
  usageEvents,
  virtualApiKeys,
} from './schema';
import { requireOrganisationId, usingTenant } from './tenant';
import { toNumber } from './money';
import { createRepositories } from './repositories';

function range(now: Date, days: number) {
  return { start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), end: now };
}

function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index] ?? null;
}

export async function getOverviewReport(db: AppDatabase, organisationId: string, now = new Date()) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (db) => {
    const repos = createRepositories(db);
    const window = range(now, 30);
    const systems = await repos.aiSystems.list(organisationId);
    const [requestStats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${requests.status} = 'succeeded')::int`,
        blocked: sql<number>`count(*) filter (where ${requests.status} = 'blocked')::int`,
      })
      .from(requests)
      .where(
        and(
          eq(requests.organisationId, organisationId),
          gte(requests.createdAt, window.start),
          lt(requests.createdAt, window.end),
        ),
      );
    const [spend] = await db
      .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organisationId, organisationId),
          gte(usageEvents.createdAt, window.start),
          lt(usageEvents.createdAt, window.end),
        ),
      );
    const warningRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(policyEvents)
      .where(
        and(
          eq(policyEvents.organisationId, organisationId),
          eq(policyEvents.result, 'warning'),
          gte(policyEvents.createdAt, window.start),
        ),
      );
    const warningCount = Number(warningRows[0]?.total ?? 0);
    const attention = systems.filter((system) => system.status === 'attention' || system.status === 'offline');
    const recentPolicyEvents = await repos.policyEvents.list(organisationId, 8);
    const daily = await db
      .select({
        day: sql<string>`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        spend: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
        requests: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organisationId, organisationId),
          gte(usageEvents.createdAt, range(now, 14).start),
          lt(usageEvents.createdAt, now),
        ),
      )
      .groupBy(sql`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`);
    return {
      systemCount: systems.length,
      spend30d: toNumber(spend?.total),
      requestCount30d: Number(requestStats?.total ?? 0),
      succeeded30d: Number(requestStats?.succeeded ?? 0),
      blocked30d: Number(requestStats?.blocked ?? 0),
      warningEvents30d: warningCount,
      needsAction: attention,
      recentPolicyEvents,
      daily: daily.map((row) => ({
        day: row.day,
        spend: toNumber(row.spend),
        requests: Number(row.requests),
      })),
    };
  });
}

export async function listSystemRows(db: AppDatabase, organisationId: string, now = new Date()) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (db) => {
    const window = range(now, 30);
    const systems = await db
      .select({
        id: aiSystems.id,
        name: aiSystems.name,
        type: aiSystems.type,
        status: aiSystems.status,
        riskLevel: aiSystems.riskLevel,
        lastActivityAt: aiSystems.lastActivityAt,
        environmentName: environments.name,
        environmentType: environments.type,
      })
      .from(aiSystems)
      .innerJoin(environments, eq(environments.id, aiSystems.environmentId))
      .where(eq(aiSystems.organisationId, organisationId))
      .orderBy(aiSystems.name);
    const rules = await db
      .select({
        aiSystemId: modelAccessRules.aiSystemId,
        provider: modelAccessRules.provider,
      })
      .from(modelAccessRules)
      .where(eq(modelAccessRules.organisationId, organisationId));
    const usage = await db
      .select({
        aiSystemId: usageEvents.aiSystemId,
        spend: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
        requests: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organisationId, organisationId),
          gte(usageEvents.createdAt, window.start),
          lt(usageEvents.createdAt, window.end),
        ),
      )
      .groupBy(usageEvents.aiSystemId);
    const requestCounts = await db
      .select({
        aiSystemId: requests.aiSystemId,
        requests: sql<number>`count(*)::int`,
      })
      .from(requests)
      .where(
        and(
          eq(requests.organisationId, organisationId),
          gte(requests.createdAt, window.start),
          lt(requests.createdAt, window.end),
        ),
      )
      .groupBy(requests.aiSystemId);
    return systems.map((system) => ({
      ...system,
      provider: [...new Set(rules.filter((rule) => rule.aiSystemId === system.id).map((rule) => rule.provider))].join(
        ', ',
      ),
      spend30d: toNumber(usage.find((row) => row.aiSystemId === system.id)?.spend),
      requests30d: Number(requestCounts.find((row) => row.aiSystemId === system.id)?.requests ?? 0),
    }));
  });
}

export async function getGatewayReport(db: AppDatabase, organisationId: string, start: Date, end: Date) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (db) => {
    const rows = await db
      .select({
        id: requests.id,
        createdAt: requests.createdAt,
        aiSystemId: requests.aiSystemId,
        provider: requests.provider,
        model: requests.model,
        status: requests.status,
        latencyMs: requests.latencyMs,
        totalTokens: requests.totalTokens,
        estimatedCostUsd: requests.estimatedCostUsd,
        policyResult: requests.policyResult,
        systemName: aiSystems.name,
      })
      .from(requests)
      .innerJoin(aiSystems, eq(aiSystems.id, requests.aiSystemId))
      .where(
        and(eq(requests.organisationId, organisationId), gte(requests.createdAt, start), lt(requests.createdAt, end)),
      )
      .orderBy(desc(requests.createdAt))
      .limit(200);
    const latencies = rows.map((row) => row.latencyMs).filter((value): value is number => value !== null);
    const total = rows.length;
    const succeeded = rows.filter((row) => row.status === 'succeeded').length;
    const failed = rows.filter((row) => row.status === 'failed').length;
    const spend = rows.reduce((sum, row) => sum + toNumber(row.estimatedCostUsd), 0);
    return {
      requests: rows,
      total,
      successRate: total === 0 ? null : succeeded / total,
      errorRate: total === 0 ? null : failed / total,
      p50: nearestRank(latencies, 0.5),
      p95: nearestRank(latencies, 0.95),
      spend,
    };
  });
}

export async function getRequestDetail(db: AppDatabase, organisationId: string, requestId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (db) => {
    const repos = createRepositories(db);
    const request = await repos.requests.findById(organisationId, requestId);
    if (!request) {
      return null;
    }
    const system = await repos.aiSystems.findById(organisationId, request.aiSystemId);
    const key = await repos.apiKeys.findById(organisationId, request.virtualApiKeyId);
    const audits = await repos.audit.listForRequest(organisationId, requestId);
    const policies = await repos.policyEvents.listForRequest(organisationId, requestId);
    return {
      request,
      system,
      keyPrefix: key?.keyPrefix ?? null,
      audits,
      policies,
    };
  });
}

export async function getSpendReport(db: AppDatabase, organisationId: string, start: Date, end: Date) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (db) => {
    const repos = createRepositories(db);
    const systems = await repos.aiSystems.list(organisationId);
    const budgetRows = await repos.budgets.list(organisationId);
    const bySystem = await db
      .select({
        aiSystemId: usageEvents.aiSystemId,
        spend: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
        requests: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organisationId, organisationId),
          gte(usageEvents.createdAt, start),
          lt(usageEvents.createdAt, end),
        ),
      )
      .groupBy(usageEvents.aiSystemId);
    const byProvider = await db
      .select({
        provider: usageEvents.provider,
        spend: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organisationId, organisationId),
          gte(usageEvents.createdAt, start),
          lt(usageEvents.createdAt, end),
        ),
      )
      .groupBy(usageEvents.provider);
    const byModel = await db
      .select({
        model: usageEvents.model,
        spend: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organisationId, organisationId),
          gte(usageEvents.createdAt, start),
          lt(usageEvents.createdAt, end),
        ),
      )
      .groupBy(usageEvents.model);
    const currentSpend = bySystem.reduce((sum, row) => sum + toNumber(row.spend), 0);
    const requestCount = bySystem.reduce((sum, row) => sum + Number(row.requests), 0);
    const monthlyBudgets = budgetRows.filter((budget) => budget.period === 'monthly');
    const budgetTotal = monthlyBudgets.reduce((sum, budget) => sum + toNumber(budget.amountUsd), 0);
    const elapsedMs = Math.max(end.getTime() - start.getTime(), 60 * 60 * 1000);
    const forecast = (currentSpend / elapsedMs) * 30 * 24 * 60 * 60 * 1000;
    return {
      currentSpend,
      budgetTotal,
      utilisation: budgetTotal > 0 ? currentSpend / budgetTotal : null,
      forecast,
      averageCost: requestCount > 0 ? currentSpend / requestCount : null,
      elapsedMs,
      bySystem: bySystem.map((row) => ({
        aiSystemId: row.aiSystemId,
        name: systems.find((system) => system.id === row.aiSystemId)?.name ?? 'Unknown system',
        spend: toNumber(row.spend),
        requests: Number(row.requests),
      })),
      byProvider: byProvider.map((row) => ({ provider: row.provider, spend: toNumber(row.spend) })),
      byModel: byModel.map((row) => ({ model: row.model, spend: toNumber(row.spend) })),
      budgets: budgetRows,
    };
  });
}

export async function listAuditRecords(
  db: AppDatabase,
  organisationId: string,
  filters: {
    start?: Date;
    end?: Date;
    actorType?: string;
    action?: string;
    severity?: string;
    result?: string;
    aiSystemId?: string;
  },
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (db) => {
  const conditions = [eq(auditEvents.organisationId, organisationId)];
  if (filters.start) {
    conditions.push(gte(auditEvents.createdAt, filters.start));
  }
  if (filters.end) {
    conditions.push(lt(auditEvents.createdAt, filters.end));
  }
  if (filters.actorType) {
    conditions.push(eq(auditEvents.actorType, filters.actorType));
  }
  if (filters.action) {
    conditions.push(eq(auditEvents.action, filters.action));
  }
  if (filters.severity) {
    conditions.push(eq(auditEvents.severity, filters.severity));
  }
  if (filters.result) {
    conditions.push(eq(auditEvents.result, filters.result));
  }
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt))
    .limit(300);
  if (!filters.aiSystemId) {
    return rows;
  }
  return rows.filter((row) => {
    const metadata = row.metadataJson as { ai_system_id?: string };
    return metadata.ai_system_id === filters.aiSystemId || row.resourceId === filters.aiSystemId;
  });
  });
}

export async function listSystemKeys(db: AppDatabase, organisationId: string, aiSystemId: string) {
  return createRepositories(db).apiKeys.list(organisationId, aiSystemId);
}

export { virtualApiKeys };
