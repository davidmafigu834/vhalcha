import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { auditActions, safeAuditMetadata } from '@vhalcha/audit';
import {
  defaultGuardSettings,
  guardActionsTaken,
  guardDataCategories,
  guardEventTypes,
  guardFailureModes,
  guardRuntimes,
  guardSeverities,
  guardStatuses,
  sanitizeEvidence,
  sanitizeGuardText,
  scoreGuardPosture,
  type GuardActionTaken,
  type GuardDataCategory,
  type GuardEventType,
  type GuardFailureMode,
  type GuardMode,
  type GuardRuntime,
  type GuardSettingsSnapshot,
  type GuardSeverity,
  type GuardStatus,
  type PostureScore,
} from '@vhalcha/guard';
import type { AppDatabase } from './client';
import { rowsOf } from './lookups';
import {
  aiSystemKnowledgeAccess,
  aiSystems,
  auditEvents,
  environments,
  guardEvents,
  guardIncidents,
  guardSettings,
  guardSystemProfiles,
  knowledgeSpaces,
  modelAccessRules,
  providerConnections,
  requests,
  users,
} from './schema';
import { ingestGuardThreat } from './guard-security';
import { requireOrganisationId, usingTenant } from './tenant';

const applicationTypes = new Set(['application', 'assistant', 'workflow', 'service']);
const openIncidentStatuses = ['open', 'investigating', 'contained'];

export interface GuardEventRecord {
  id: string;
  aiSystemId: string | null;
  systemName: string | null;
  eventType: string;
  severity: string;
  title: string;
  description: string;
  actionTaken: string;
  status: string;
  provider: string | null;
  model: string | null;
  runtime: string | null;
  actorLabel: string | null;
  dataCategory: string | null;
  policyName: string | null;
  policyId: string | null;
  policyVersion: number | null;
  requestId: string | null;
  traceId: string | null;
  decisionId: string | null;
  evidence: Record<string, unknown>;
  occurredAt: Date;
}

export interface GuardInventorySystem {
  id: string;
  name: string;
  type: string;
  description: string;
  ownerName: string | null;
  environmentId: string;
  environmentName: string;
  environmentType: string;
  provider: string | null;
  models: string[];
  dataAccess: string[];
  runtime: GuardRuntime;
  guardStatus: GuardStatus;
  riskLevel: string;
  lastActivityAt: Date | null;
  sensitiveDataUnrestricted: boolean;
  overprivileged: boolean;
  profileId: string | null;
}

export interface GuardModelRow {
  provider: string;
  model: string;
  allowed: boolean;
  systems: string[];
}

export interface GuardProviderRow {
  provider: string;
  systems: number;
  connectionStatus: string | null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function snapshotFromRow(row: typeof guardSettings.$inferSelect | undefined): GuardSettingsSnapshot {
  if (!row) {
    return { ...defaultGuardSettings };
  }
  const mode = row.mode === 'protect' ? 'protect' : 'monitor';
  const failure = guardFailureModes.find((item) => item === row.enforcementFailureMode) ?? 'fail_open';
  const label = row.organisationLabel === 'demo' ? 'demo' : 'standard';
  return {
    mode,
    enforcementFailureMode: failure,
    retentionDays: row.retentionDays,
    auditLoggingEnabled: row.auditLoggingEnabled,
    guardEnabled: row.guardEnabled,
    organisationLabel: label,
  };
}

function assertEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  const match = allowed.find((item) => item === value);
  if (!match) {
    throw new Error(`Invalid Guard ${label}.`);
  }
  return match;
}

function cleanLabels(values: string[]): string[] {
  const cleaned = values
    .map((value) => sanitizeGuardText(value, 80))
    .map((value) => value.replace(/[^\w .,&/()-]/g, '').trim())
    .filter((value) => value.length > 0);
  return [...new Set(cleaned)].slice(0, 12);
}

async function loadInventory(db: AppDatabase, organisationId: string): Promise<{
  systems: GuardInventorySystem[];
  models: GuardModelRow[];
  providers: GuardProviderRow[];
}> {
  const systems = await db
    .select()
    .from(aiSystems)
    .where(eq(aiSystems.organisationId, organisationId))
    .orderBy(aiSystems.name);
  const ownerIds = systems.map((system) => system.ownerUserId).filter((id): id is string => Boolean(id));
  const owners = ownerIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.organisationId, organisationId), inArray(users.id, ownerIds)))
    : [];
  const environmentRows = await db
    .select()
    .from(environments)
    .where(eq(environments.organisationId, organisationId));
  const profiles = await db
    .select()
    .from(guardSystemProfiles)
    .where(eq(guardSystemProfiles.organisationId, organisationId));
  const rules = await db
    .select()
    .from(modelAccessRules)
    .where(eq(modelAccessRules.organisationId, organisationId));
  const access = await db
    .select({
      aiSystemId: aiSystemKnowledgeAccess.aiSystemId,
      spaceName: knowledgeSpaces.name,
    })
    .from(aiSystemKnowledgeAccess)
    .innerJoin(knowledgeSpaces, eq(knowledgeSpaces.id, aiSystemKnowledgeAccess.knowledgeSpaceId))
    .where(eq(aiSystemKnowledgeAccess.organisationId, organisationId));
  const connections = await db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.organisationId, organisationId));
  const latest = rowsOf<{ ai_system_id: string; provider: string; model: string }>(
    await db.execute(sql`
      select distinct on (ai_system_id) ai_system_id, provider, model
      from requests
      where organisation_id = ${organisationId}
      order by ai_system_id, created_at desc
    `),
  );

  const ownerById = new Map(owners.map((owner) => [owner.id, owner.name]));
  const environmentById = new Map(environmentRows.map((environment) => [environment.id, environment]));
  const profileBySystem = new Map(profiles.map((profile) => [profile.aiSystemId, profile]));
  const latestBySystem = new Map(latest.map((row) => [row.ai_system_id, row]));
  const rulesBySystem = new Map<string, typeof rules>();
  for (const rule of rules) {
    const list = rulesBySystem.get(rule.aiSystemId) ?? [];
    list.push(rule);
    rulesBySystem.set(rule.aiSystemId, list);
  }
  const knowledgeBySystem = new Map<string, string[]>();
  for (const row of access) {
    const list = knowledgeBySystem.get(row.aiSystemId) ?? [];
    list.push(row.spaceName);
    knowledgeBySystem.set(row.aiSystemId, list);
  }

  const inventory: GuardInventorySystem[] = systems.map((system) => {
    const profile = profileBySystem.get(system.id);
    const environment = environmentById.get(system.environmentId);
    const systemRules = rulesBySystem.get(system.id) ?? [];
    const recent = latestBySystem.get(system.id);
    const allowedProvider = systemRules.find((rule) => rule.isAllowed)?.provider ?? systemRules[0]?.provider ?? null;
    const declared = asStringArray(profile?.dataAccess);
    const knowledge = knowledgeBySystem.get(system.id) ?? [];
    const runtime = guardRuntimes.find((item) => item === profile?.runtime) ?? 'unknown';
    const guardStatus = guardStatuses.find((item) => item === profile?.guardStatus) ?? 'unknown';
    return {
      id: system.id,
      name: system.name,
      type: system.type,
      description: system.description,
      ownerName: system.ownerUserId ? (ownerById.get(system.ownerUserId) ?? null) : null,
      environmentId: system.environmentId,
      environmentName: environment?.name ?? 'Unknown environment',
      environmentType: environment?.type ?? 'unknown',
      provider: recent?.provider ?? allowedProvider,
      models: systemRules.map((rule) => rule.modelPattern),
      dataAccess: [...new Set([...declared, ...knowledge])],
      runtime,
      guardStatus,
      riskLevel: system.riskLevel,
      lastActivityAt: system.lastActivityAt,
      sensitiveDataUnrestricted: profile?.sensitiveDataUnrestricted ?? false,
      overprivileged: profile?.overprivileged ?? false,
      profileId: profile?.id ?? null,
    };
  });

  const modelMap = new Map<string, GuardModelRow>();
  for (const system of inventory) {
    const systemRules = rulesBySystem.get(system.id) ?? [];
    for (const rule of systemRules) {
      const key = `${rule.provider}:${rule.modelPattern}`;
      const existing = modelMap.get(key);
      if (existing) {
        existing.systems.push(system.name);
        existing.allowed = existing.allowed && rule.isAllowed;
      } else {
        modelMap.set(key, {
          provider: rule.provider,
          model: rule.modelPattern,
          allowed: rule.isAllowed,
          systems: [system.name],
        });
      }
    }
  }

  const providerCounts = new Map<string, number>();
  for (const system of inventory) {
    if (!system.provider) continue;
    providerCounts.set(system.provider, (providerCounts.get(system.provider) ?? 0) + 1);
  }
  for (const connection of connections) {
    if (!providerCounts.has(connection.provider)) {
      providerCounts.set(connection.provider, 0);
    }
  }
  const connectionByProvider = new Map(connections.map((connection) => [connection.provider, connection.status]));
  const providers: GuardProviderRow[] = [...providerCounts.entries()]
    .map(([provider, count]) => ({
      provider,
      systems: count,
      connectionStatus: connectionByProvider.get(provider) ?? null,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));

  return { systems: inventory, models: [...modelMap.values()], providers };
}

function mapEvent(
  row: typeof guardEvents.$inferSelect,
  systemName: string | null,
): GuardEventRecord {
  return {
    id: row.id,
    aiSystemId: row.aiSystemId,
    systemName,
    eventType: row.eventType,
    severity: row.severity,
    title: row.title,
    description: row.description,
    actionTaken: row.actionTaken,
    status: row.status,
    provider: row.provider,
    model: row.model,
    runtime: row.runtime,
    actorLabel: row.actorLabel,
    dataCategory: row.dataCategory,
    policyName: row.policyName,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    requestId: row.requestId,
    traceId: row.traceId,
    decisionId: row.decisionId,
    evidence: row.evidenceJson ?? {},
    occurredAt: row.occurredAt,
  };
}

export async function getGuardSettings(db: AppDatabase, organisationId: string): Promise<GuardSettingsSnapshot> {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardSettings)
      .where(eq(guardSettings.organisationId, organisationId))
      .limit(1);
    return snapshotFromRow(rows[0]);
  });
}

export async function updateGuardSettings(
  db: AppDatabase,
  organisationId: string,
  input: {
    actorUserId: string;
    retentionDays?: number;
    enforcementFailureMode?: GuardFailureMode;
    auditLoggingEnabled?: boolean;
    guardEnabled?: boolean;
    mode?: GuardMode;
    protectEnabled?: boolean;
  },
): Promise<GuardSettingsSnapshot> {
  requireOrganisationId(organisationId);
  if (input.retentionDays !== undefined && (input.retentionDays < 7 || input.retentionDays > 3650)) {
    throw new Error('Retention must be between 7 and 3650 days.');
  }
  if (input.enforcementFailureMode) {
    assertEnum(input.enforcementFailureMode, guardFailureModes, 'failure mode');
  }
  return usingTenant(db, organisationId, async (tx) => {
    const existing = await tx
      .select()
      .from(guardSettings)
      .where(eq(guardSettings.organisationId, organisationId))
      .limit(1);
    const current = snapshotFromRow(existing[0]);
    if (input.mode === 'protect' && !input.protectEnabled) {
      throw new Error('Protect mode is not enabled for this deployment.');
    }
    const next: GuardSettingsSnapshot = {
      ...current,
      retentionDays: input.retentionDays ?? current.retentionDays,
      enforcementFailureMode: input.enforcementFailureMode ?? current.enforcementFailureMode,
      auditLoggingEnabled: input.auditLoggingEnabled ?? current.auditLoggingEnabled,
      guardEnabled: input.guardEnabled ?? current.guardEnabled,
      mode: input.mode ?? current.mode,
    };
    const now = new Date();
    if (!existing[0]) {
      await tx.insert(guardSettings).values({
        id: randomUUID(),
        organisationId,
        mode: next.mode,
        enforcementFailureMode: next.enforcementFailureMode,
        retentionDays: next.retentionDays,
        auditLoggingEnabled: next.auditLoggingEnabled,
        guardEnabled: next.guardEnabled,
        organisationLabel: 'standard',
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await tx
        .update(guardSettings)
        .set({
          mode: next.mode,
          enforcementFailureMode: next.enforcementFailureMode,
          retentionDays: next.retentionDays,
          auditLoggingEnabled: next.auditLoggingEnabled,
          guardEnabled: next.guardEnabled,
          updatedAt: now,
        })
        .where(eq(guardSettings.organisationId, organisationId));
    }
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      organisationId,
      environmentId: null,
      actorType: 'user',
      actorId: input.actorUserId,
      action: auditActions.guardSettingsUpdated,
      resourceType: 'guard_settings',
      resourceId: organisationId,
      result: 'success',
      severity: 'info',
      requestId: null,
      metadataJson: safeAuditMetadata({
        retention_days: next.retentionDays,
        enforcement_failure_mode: next.enforcementFailureMode,
        audit_logging_enabled: next.auditLoggingEnabled,
        guard_enabled: next.guardEnabled,
        mode: next.mode,
      }),
      createdAt: now,
    });
    return next;
  });
}

export async function markGuardOrganisationDemo(db: AppDatabase, organisationId: string): Promise<void> {
  requireOrganisationId(organisationId);
  await usingTenant(db, organisationId, async (tx) => {
    const existing = await tx
      .select()
      .from(guardSettings)
      .where(eq(guardSettings.organisationId, organisationId))
      .limit(1);
    const now = new Date();
    if (!existing[0]) {
      await tx.insert(guardSettings).values({
        id: randomUUID(),
        organisationId,
        mode: 'monitor',
        enforcementFailureMode: 'fail_open',
        retentionDays: 90,
        auditLoggingEnabled: true,
        guardEnabled: true,
        organisationLabel: 'demo',
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    if (existing[0].organisationLabel !== 'demo') {
      await tx
        .update(guardSettings)
        .set({ organisationLabel: 'demo', updatedAt: now })
        .where(eq(guardSettings.organisationId, organisationId));
    }
  });
}

export async function upsertGuardProfile(
  db: AppDatabase,
  organisationId: string,
  input: {
    aiSystemId: string;
    actorUserId: string;
    guardStatus: GuardStatus;
    runtime: GuardRuntime;
    dataAccess: string[];
    sensitiveDataUnrestricted: boolean;
    overprivileged: boolean;
  },
): Promise<void> {
  requireOrganisationId(organisationId);
  const guardStatus = assertEnum(input.guardStatus, guardStatuses, 'status');
  const runtime = assertEnum(input.runtime, guardRuntimes, 'runtime');
  const dataAccess = cleanLabels(input.dataAccess);
  await usingTenant(db, organisationId, async (tx) => {
    const systems = await tx
      .select({ id: aiSystems.id })
      .from(aiSystems)
      .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, input.aiSystemId)))
      .limit(1);
    if (!systems[0]) {
      throw new Error('AI system was not found in this organisation.');
    }
    if (guardStatus === 'protected') {
      throw new Error('Protected status is unavailable until Guard enforcement is connected.');
    }
    const now = new Date();
    const existing = await tx
      .select()
      .from(guardSystemProfiles)
      .where(
        and(eq(guardSystemProfiles.organisationId, organisationId), eq(guardSystemProfiles.aiSystemId, input.aiSystemId)),
      )
      .limit(1);
    if (!existing[0]) {
      await tx.insert(guardSystemProfiles).values({
        id: randomUUID(),
        organisationId,
        aiSystemId: input.aiSystemId,
        guardStatus,
        runtime,
        dataAccess,
        sensitiveDataUnrestricted: input.sensitiveDataUnrestricted,
        overprivileged: input.overprivileged,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await tx
        .update(guardSystemProfiles)
        .set({
          guardStatus,
          runtime,
          dataAccess,
          sensitiveDataUnrestricted: input.sensitiveDataUnrestricted,
          overprivileged: input.overprivileged,
          updatedAt: now,
        })
        .where(eq(guardSystemProfiles.id, existing[0].id));
    }
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      organisationId,
      environmentId: null,
      actorType: 'user',
      actorId: input.actorUserId,
      action: auditActions.guardProfileUpdated,
      resourceType: 'ai_system',
      resourceId: input.aiSystemId,
      result: 'success',
      severity: 'info',
      requestId: null,
      metadataJson: safeAuditMetadata({
        ai_system_id: input.aiSystemId,
        guard_status: guardStatus,
        runtime,
        data_access_count: dataAccess.length,
        sensitive_data_unrestricted: input.sensitiveDataUnrestricted,
        overprivileged: input.overprivileged,
      }),
      createdAt: now,
    });
  });
}

export async function listGuardInventory(db: AppDatabase, organisationId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, (tx) => loadInventory(tx, organisationId));
}

export async function listGuardEvents(
  db: AppDatabase,
  organisationId: string,
  filters: {
    start?: Date;
    end?: Date;
    types?: readonly GuardEventType[];
    severity?: GuardSeverity;
    aiSystemId?: string;
    status?: string;
    limit?: number;
  } = {},
): Promise<GuardEventRecord[]> {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const conditions = [eq(guardEvents.organisationId, organisationId)];
    if (filters.start) conditions.push(gte(guardEvents.occurredAt, filters.start));
    if (filters.end) conditions.push(lt(guardEvents.occurredAt, filters.end));
    if (filters.types && filters.types.length > 0) conditions.push(inArray(guardEvents.eventType, [...filters.types]));
    if (filters.severity) conditions.push(eq(guardEvents.severity, filters.severity));
    if (filters.aiSystemId) conditions.push(eq(guardEvents.aiSystemId, filters.aiSystemId));
    if (filters.status) conditions.push(eq(guardEvents.status, filters.status));
    const rows = await tx
      .select()
      .from(guardEvents)
      .where(and(...conditions))
      .orderBy(desc(guardEvents.occurredAt))
      .limit(filters.limit ?? 100);
    const systemIds = rows.map((row) => row.aiSystemId).filter((id): id is string => Boolean(id));
    const names = systemIds.length
      ? await tx
          .select({ id: aiSystems.id, name: aiSystems.name })
          .from(aiSystems)
          .where(and(eq(aiSystems.organisationId, organisationId), inArray(aiSystems.id, systemIds)))
      : [];
    const nameById = new Map(names.map((system) => [system.id, system.name]));
    return rows.map((row) => mapEvent(row, row.aiSystemId ? (nameById.get(row.aiSystemId) ?? null) : null));
  });
}

export async function getGuardEvent(
  db: AppDatabase,
  organisationId: string,
  eventId: string,
): Promise<GuardEventRecord | null> {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardEvents)
      .where(and(eq(guardEvents.organisationId, organisationId), eq(guardEvents.id, eventId)))
      .limit(1);
    const event = rows[0];
    if (!event) {
      return null;
    }
    let systemName: string | null = null;
    if (event.aiSystemId) {
      const systems = await tx
        .select({ name: aiSystems.name })
        .from(aiSystems)
        .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, event.aiSystemId)))
        .limit(1);
      systemName = systems[0]?.name ?? null;
    }
    return mapEvent(event, systemName);
  });
}

export async function recordGuardEvent(
  db: AppDatabase,
  input: {
    organisationId: string;
    aiSystemId?: string | null;
    environmentId?: string | null;
    eventType: GuardEventType;
    severity: GuardSeverity;
    title: string;
    description?: string;
    actionTaken: GuardActionTaken;
    provider?: string | null;
    model?: string | null;
    runtime?: string | null;
    actorLabel?: string | null;
    dataCategory?: GuardDataCategory | null;
    policyName?: string | null;
    policyId?: string | null;
    policyVersion?: number | null;
    requestId?: string | null;
    traceId?: string | null;
    decisionId?: string | null;
    evidence?: unknown;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  },
): Promise<GuardEventRecord> {
  requireOrganisationId(input.organisationId);
  const eventType = assertEnum(input.eventType, guardEventTypes, 'event type');
  const severity = assertEnum(input.severity, guardSeverities, 'severity');
  const actionTaken = assertEnum(input.actionTaken, guardActionsTaken, 'action');
  const dataCategory = input.dataCategory
    ? assertEnum(input.dataCategory, guardDataCategories, 'data category')
    : null;
  const title = sanitizeGuardText(input.title, 160);
  if (!title) {
    throw new Error('Guard event title is required.');
  }
  return usingTenant(db, input.organisationId, async (tx) => {
    if (input.aiSystemId) {
      const systems = await tx
        .select({ id: aiSystems.id })
        .from(aiSystems)
        .where(and(eq(aiSystems.organisationId, input.organisationId), eq(aiSystems.id, input.aiSystemId)))
        .limit(1);
      if (!systems[0]) {
        throw new Error('AI system was not found in this organisation.');
      }
    }
    const now = new Date();
    const row = {
      id: randomUUID(),
      organisationId: input.organisationId,
      aiSystemId: input.aiSystemId ?? null,
      environmentId: input.environmentId ?? null,
      eventType,
      severity,
      title,
      description: sanitizeGuardText(input.description ?? '', 500),
      actionTaken,
      status: 'open',
      provider: input.provider ? sanitizeGuardText(input.provider, 64) : null,
      model: input.model ? sanitizeGuardText(input.model, 128) : null,
      runtime: input.runtime ? sanitizeGuardText(input.runtime, 64) : null,
      actorLabel: input.actorLabel ? sanitizeGuardText(input.actorLabel, 120) : null,
      dataCategory,
      policyName: input.policyName ? sanitizeGuardText(input.policyName, 160) : null,
      policyId: input.policyId ?? null,
      policyVersion: input.policyVersion ?? null,
      requestId: input.requestId ?? null,
      traceId: input.traceId ? sanitizeGuardText(input.traceId, 80) : null,
      decisionId: input.decisionId ? sanitizeGuardText(input.decisionId, 80) : null,
      evidenceJson: sanitizeEvidence(input.evidence),
      metadataJson: safeAuditMetadata(input.metadata),
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    };
    await tx.insert(guardEvents).values(row);
    await ingestGuardThreat(db, input.organisationId, row.id);
    return mapEvent(row, null);
  });
}

export async function markGuardEventExpected(
  db: AppDatabase,
  organisationId: string,
  eventId: string,
  actorUserId: string,
): Promise<GuardEventRecord | null> {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardEvents)
      .where(and(eq(guardEvents.organisationId, organisationId), eq(guardEvents.id, eventId)))
      .limit(1);
    const event = rows[0];
    if (!event) {
      return null;
    }
    if (event.status !== 'expected') {
      const now = new Date();
      await tx
        .update(guardEvents)
        .set({ status: 'expected' })
        .where(and(eq(guardEvents.organisationId, organisationId), eq(guardEvents.id, eventId)));
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        organisationId,
        environmentId: event.environmentId,
        actorType: 'user',
        actorId: actorUserId,
        action: auditActions.guardEventExpected,
        resourceType: 'guard_event',
        resourceId: eventId,
        result: 'success',
        severity: 'info',
        requestId: event.requestId,
        metadataJson: safeAuditMetadata({
          ai_system_id: event.aiSystemId,
          event_type: event.eventType,
          previous_status: event.status,
        }),
        createdAt: now,
      });
      event.status = 'expected';
    }
    return mapEvent(event, null);
  });
}

export async function countOpenGuardIncidents(db: AppDatabase, organisationId: string): Promise<number> {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(guardIncidents)
      .where(and(eq(guardIncidents.organisationId, organisationId), inArray(guardIncidents.status, openIncidentStatuses)));
    return Number(rows[0]?.total ?? 0);
  });
}

export async function listGuardIncidents(db: AppDatabase, organisationId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    return tx
      .select()
      .from(guardIncidents)
      .where(eq(guardIncidents.organisationId, organisationId))
      .orderBy(desc(guardIncidents.updatedAt))
      .limit(100);
  });
}

export async function getGuardOverview(
  db: AppDatabase,
  organisationId: string,
  range: { start: Date; end: Date },
  options: { deploymentGuardEnabled: boolean },
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const settingsRows = await tx
      .select()
      .from(guardSettings)
      .where(eq(guardSettings.organisationId, organisationId))
      .limit(1);
    const settings = snapshotFromRow(settingsRows[0]);
    const inventory = await loadInventory(tx, organisationId);
    const events = await tx
      .select()
      .from(guardEvents)
      .where(
        and(
          eq(guardEvents.organisationId, organisationId),
          gte(guardEvents.occurredAt, range.start),
          lt(guardEvents.occurredAt, range.end),
        ),
      )
      .orderBy(desc(guardEvents.occurredAt))
      .limit(50);
    const systemIds = events.map((event) => event.aiSystemId).filter((id): id is string => Boolean(id));
    const names = systemIds.length
      ? await tx
          .select({ id: aiSystems.id, name: aiSystems.name })
          .from(aiSystems)
          .where(and(eq(aiSystems.organisationId, organisationId), inArray(aiSystems.id, systemIds)))
      : [];
    const nameById = new Map(names.map((system) => [system.id, system.name]));
    const mapped = events.map((event) =>
      mapEvent(event, event.aiSystemId ? (nameById.get(event.aiSystemId) ?? null) : null),
    );
    const openIncidents = await tx
      .select({
        total: sql<number>`count(*)::int`,
        high: sql<number>`count(*) filter (where ${guardIncidents.severity} in ('high', 'critical'))::int`,
      })
      .from(guardIncidents)
      .where(and(eq(guardIncidents.organisationId, organisationId), inArray(guardIncidents.status, openIncidentStatuses)));
    const openCriticalViolations = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(guardEvents)
      .where(
        and(
          eq(guardEvents.organisationId, organisationId),
          eq(guardEvents.eventType, 'policy_violation'),
          eq(guardEvents.severity, 'critical'),
          eq(guardEvents.status, 'open'),
        ),
      );
    const metricRows = await tx
      .select({
        inspected: sql<number>`count(distinct ${guardEvents.requestId}) filter (where ${guardEvents.requestId} is not null)::int`,
        violations: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'policy_violation')::int`,
        threats: sql<number>`count(*) filter (where ${guardEvents.eventType} in ('prompt_injection', 'sensitive_data', 'tool_access', 'permission_escalation', 'model_violation', 'runtime_alert', 'anomalous_activity'))::int`,
        blocked: sql<number>`count(*) filter (where ${guardEvents.actionTaken} = 'block' or ${guardEvents.eventType} = 'blocked_request')::int`,
        redacted: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'redacted_request')::int`,
        sensitive: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'sensitive_data')::int`,
      })
      .from(guardEvents)
      .where(
        and(
          eq(guardEvents.organisationId, organisationId),
          gte(guardEvents.occurredAt, range.start),
          lt(guardEvents.occurredAt, range.end),
        ),
      );
    const posture: PostureScore = scoreGuardPosture({
      aiSystemCount: inventory.systems.length,
      unprotectedSystems: inventory.systems.filter((system) => system.guardStatus === 'unprotected').length,
      unknownSystems: inventory.systems.filter((system) => system.guardStatus === 'unknown').length,
      unresolvedHighIncidents: Number(openIncidents[0]?.high ?? 0),
      criticalPolicyViolations: Number(openCriticalViolations[0]?.total ?? 0),
      unrestrictedSensitiveDataSystems: inventory.systems.filter((system) => system.sensitiveDataUnrestricted).length,
      auditLoggingEnabled: settings.auditLoggingEnabled,
      overprivilegedAgents: inventory.systems.filter((system) => system.overprivileged).length,
      enforcementDisabled: !options.deploymentGuardEnabled || !settings.guardEnabled,
    });
    const riskRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const highestRisk = [...inventory.systems]
      .sort((left, right) => (riskRank[left.riskLevel] ?? 9) - (riskRank[right.riskLevel] ?? 9))
      .slice(0, 5);
    const covered = inventory.systems.filter(
      (system) => system.guardStatus === 'protected' || system.guardStatus === 'monitored',
    ).length;
    return {
      settings,
      posture,
      metrics: {
        aiSystems: inventory.systems.length,
        protectedSystems: inventory.systems.filter((system) => system.guardStatus === 'protected').length,
        requestsInspected: Number(metricRows[0]?.inspected ?? 0),
        policyViolations: Number(metricRows[0]?.violations ?? 0),
        threatsDetected: Number(metricRows[0]?.threats ?? 0),
        blockedRequests: Number(metricRows[0]?.blocked ?? 0),
        redactedRequests: Number(metricRows[0]?.redacted ?? 0),
        sensitiveDataEvents: Number(metricRows[0]?.sensitive ?? 0),
        openIncidents: Number(openIncidents[0]?.total ?? 0),
      },
      events: mapped.slice(0, 12),
      highestRisk,
      coverage: {
        covered,
        total: inventory.systems.length,
      },
    };
  });
}

export async function getGuardSystemDetail(db: AppDatabase, organisationId: string, aiSystemId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const inventory = await loadInventory(tx, organisationId);
    const system = inventory.systems.find((item) => item.id === aiSystemId);
    if (!system) {
      return null;
    }
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const requestStats = await tx
      .select({
        total: sql<number>`count(*)::int`,
        blocked: sql<number>`count(*) filter (where ${requests.status} = 'blocked')::int`,
      })
      .from(requests)
      .where(
        and(eq(requests.organisationId, organisationId), eq(requests.aiSystemId, aiSystemId), gte(requests.createdAt, since)),
      );
    const rules = await tx
      .select()
      .from(modelAccessRules)
      .where(and(eq(modelAccessRules.organisationId, organisationId), eq(modelAccessRules.aiSystemId, aiSystemId)));
    const events = await tx
      .select()
      .from(guardEvents)
      .where(and(eq(guardEvents.organisationId, organisationId), eq(guardEvents.aiSystemId, aiSystemId)))
      .orderBy(desc(guardEvents.occurredAt))
      .limit(50);
    const audit = await tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organisationId, organisationId), eq(auditEvents.resourceId, aiSystemId)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(30);
    const mapped = events.map((event) => mapEvent(event, system.name));
    return {
      system,
      rules,
      events: mapped,
      audit: audit.filter((event) => event.action.startsWith('guard.')),
      metrics: {
        requests30d: Number(requestStats[0]?.total ?? 0),
        gatewayBlocked30d: Number(requestStats[0]?.blocked ?? 0),
        violations: mapped.filter((event) => event.eventType === 'policy_violation').length,
        guardBlocked: mapped.filter((event) => event.actionTaken === 'block').length,
        sensitiveDataEvents: mapped.filter((event) => event.eventType === 'sensitive_data').length,
      },
    };
  });
}

export async function listGuardAudit(
  db: AppDatabase,
  organisationId: string,
  filters: { action?: string; aiSystemId?: string } = {},
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const conditions = [eq(auditEvents.organisationId, organisationId), sql`${auditEvents.action} like 'guard.%'`];
    if (filters.action) {
      conditions.push(eq(auditEvents.action, filters.action));
    }
    const rows = await tx
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt))
      .limit(200);
    if (!filters.aiSystemId) {
      return rows;
    }
    return rows.filter((row) => row.resourceId === filters.aiSystemId);
  });
}

export function guardInventoryTab(system: GuardInventorySystem, tab: string | undefined): boolean {
  if (!tab || tab === 'all') return true;
  if (tab === 'applications') return applicationTypes.has(system.type);
  if (tab === 'agents') return system.type === 'agent';
  if (tab === 'unknown') return system.guardStatus === 'unknown';
  return true;
}
