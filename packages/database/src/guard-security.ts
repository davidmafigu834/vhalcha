import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { auditActions, safeAuditMetadata } from '@vhalcha/audit';
import {
  classifyGuardThreat,
  explainGuardThreat,
  formatGuardSequence,
  guardThreatFingerprint,
  guardThreatStatuses,
  guardThreatTypes,
  higherThreatSeverity,
  sanitizeGuardText,
  withinThreatWindow,
  type GuardThreatSeverity,
  type GuardThreatStatus,
  type GuardThreatType,
} from '@vhalcha/guard';
import type { AppDatabase } from './client';
import {
  aiSystems,
  auditEvents,
  environments,
  guardDecisions,
  guardDisplaySequences,
  guardEvents,
  guardIncidentEvents,
  guardIncidentNotes,
  guardIncidentThreats,
  guardIncidentTimeline,
  guardIncidents,
  guardThreatActivity,
  guardThreatEvents,
  guardThreats,
  users,
} from './schema';
import { requireOrganisationId, usingTenant } from './tenant';

const pageSize = 25;
const activeThreatStatuses = ['open', 'investigating', 'contained'] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ThreatRow = typeof guardThreats.$inferSelect;
type IncidentRow = typeof guardIncidents.$inferSelect;

function pageOf(value: number | undefined) {
  return Number.isInteger(value) && value && value > 0 ? value : 1;
}

async function nextDisplayNumber(tx: AppDatabase, organisationId: string, kind: 'threat' | 'incident') {
  const rows = await tx
    .insert(guardDisplaySequences)
    .values({ organisationId, kind, lastValue: 1 })
    .onConflictDoUpdate({
      target: [guardDisplaySequences.organisationId, guardDisplaySequences.kind],
      set: { lastValue: sql`${guardDisplaySequences.lastValue} + 1` },
    })
    .returning({ lastValue: guardDisplaySequences.lastValue });
  return rows[0]?.lastValue ?? 1;
}

async function writeAudit(
  tx: AppDatabase,
  input: { organisationId: string; actorUserId: string; action: string; resourceType: string; resourceId: string; summary: string },
) {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    organisationId: input.organisationId,
    actorType: 'user',
    actorId: input.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    result: 'success',
    severity: 'info',
    metadataJson: safeAuditMetadata({ summary: input.summary }),
    createdAt: new Date(),
  });
}

function noteText(value: string) {
  return sanitizeGuardText(value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]'), 2000);
}

export async function ingestGuardThreat(db: AppDatabase, organisationId: string, eventId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const existing = await tx
      .select({ threatId: guardThreatEvents.threatId })
      .from(guardThreatEvents)
      .where(and(eq(guardThreatEvents.organisationId, organisationId), eq(guardThreatEvents.eventId, eventId)))
      .limit(1);
    if (existing[0]) return existing[0].threatId;
    const events = await tx
      .select()
      .from(guardEvents)
      .where(and(eq(guardEvents.organisationId, organisationId), eq(guardEvents.id, eventId)))
      .limit(1);
    const event = events[0];
    if (!event) return null;
    const evidence = (event.evidenceJson ?? {}) as Record<string, unknown>;
    const classified = classifyGuardThreat({
      eventType: event.eventType,
      dataCategory: event.dataCategory,
      evidence,
    });
    if (!classified) return null;
    const classification = classified.classifications.join(',');
    const fingerprint = guardThreatFingerprint({
      organizationId: organisationId,
      systemId: event.aiSystemId,
      type: classified.type,
      policyId: event.policyId,
      classification,
      provider: event.provider,
      model: event.model,
    });
    const grouped = await tx
      .select()
      .from(guardThreats)
      .where(
        and(
          eq(guardThreats.organisationId, organisationId),
          eq(guardThreats.fingerprint, fingerprint),
          inArray(guardThreats.status, [...activeThreatStatuses]),
        ),
      )
      .orderBy(desc(guardThreats.lastSeenAt))
      .limit(1);
    const match = grouped[0];
    const failClosed = classified.outcome === 'failed_closed' ? 1 : 0;
    if (match && withinThreatWindow(match.lastSeenAt, event.occurredAt)) {
      const failClosedCount = match.failClosedCount + failClosed;
      const again = classifyGuardThreat({
        eventType: event.eventType,
        dataCategory: event.dataCategory,
        evidence,
        failClosedCount,
      });
      const severity = higherThreatSeverity(match.severity as GuardThreatSeverity, again?.severity ?? classified.severity);
      const lastSeenAt = event.occurredAt > match.lastSeenAt ? event.occurredAt : match.lastSeenAt;
      const firstSeenAt = event.occurredAt < match.firstSeenAt ? event.occurredAt : match.firstSeenAt;
      await tx
        .update(guardThreats)
        .set({
          occurrenceCount: match.occurrenceCount + 1,
          failClosedCount,
          severity,
          firstSeenAt,
          lastSeenAt,
          outcome: classified.outcome || match.outcome,
          redactionSummary: classified.redactionSummary || match.redactionSummary,
          requestId: event.occurredAt >= match.lastSeenAt ? event.requestId : match.requestId,
          traceId: event.occurredAt >= match.lastSeenAt ? event.traceId : match.traceId,
          decisionId: match.decisionId ?? event.decisionId,
          updatedAt: new Date(),
        })
        .where(and(eq(guardThreats.organisationId, organisationId), eq(guardThreats.id, match.id)));
      await tx.insert(guardThreatEvents).values({
        id: randomUUID(),
        organisationId,
        threatId: match.id,
        eventId: event.id,
        occurredAt: event.occurredAt,
      });
      return match.id;
    }
    let systemName: string | null = null;
    let environmentLabel: string | null = null;
    if (event.aiSystemId) {
      const systems = await tx
        .select({ name: aiSystems.name })
        .from(aiSystems)
        .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, event.aiSystemId)))
        .limit(1);
      systemName = systems[0]?.name ?? null;
    }
    if (event.environmentId) {
      const environment = await tx
        .select({ type: environments.type, name: environments.name })
        .from(environments)
        .where(and(eq(environments.organisationId, organisationId), eq(environments.id, event.environmentId)))
        .limit(1);
      environmentLabel = environment[0] ? `${environment[0].name} (${environment[0].type})` : null;
    }
    const displayNumber = await nextDisplayNumber(tx, organisationId, 'threat');
    const threatId = randomUUID();
    await tx.insert(guardThreats).values({
      id: threatId,
      organisationId,
      displayNumber,
      type: classified.type,
      severity: classified.severity,
      status: 'open',
      title: classified.title,
      primaryEventId: event.id,
      decisionId: event.decisionId,
      aiSystemId: event.aiSystemId,
      systemName,
      environmentId: event.environmentId,
      environmentLabel,
      provider: event.provider,
      model: event.model,
      policyId: event.policyId,
      policyName: event.policyName,
      policyVersion: event.policyVersion,
      requestId: event.requestId,
      traceId: event.traceId,
      classification,
      outcome: classified.outcome,
      redactionSummary: classified.redactionSummary,
      fingerprint,
      occurrenceCount: 1,
      failClosedCount: failClosed,
      firstSeenAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
    });
    await tx.insert(guardThreatEvents).values({
      id: randomUUID(),
      organisationId,
      threatId,
      eventId: event.id,
      occurredAt: event.occurredAt,
    });
    return threatId;
  });
}

export interface GuardThreatFilters {
  start?: Date;
  end?: Date;
  severity?: GuardThreatSeverity;
  status?: GuardThreatStatus;
  type?: GuardThreatType;
  aiSystemId?: string;
  environmentId?: string;
  provider?: string;
  model?: string;
  policyId?: string;
  outcome?: string;
  search?: string;
  page?: number;
}

function threatConditions(organisationId: string, filters: GuardThreatFilters) {
  const conditions = [eq(guardThreats.organisationId, organisationId)];
  if (filters.start) conditions.push(gte(guardThreats.lastSeenAt, filters.start));
  if (filters.end) conditions.push(lt(guardThreats.lastSeenAt, filters.end));
  if (filters.severity) conditions.push(eq(guardThreats.severity, filters.severity));
  if (filters.status) conditions.push(eq(guardThreats.status, filters.status));
  if (filters.type) conditions.push(eq(guardThreats.type, filters.type));
  if (filters.aiSystemId) conditions.push(eq(guardThreats.aiSystemId, filters.aiSystemId));
  if (filters.environmentId) conditions.push(eq(guardThreats.environmentId, filters.environmentId));
  if (filters.provider) conditions.push(eq(guardThreats.provider, filters.provider));
  if (filters.model) conditions.push(eq(guardThreats.model, filters.model));
  if (filters.policyId) conditions.push(eq(guardThreats.policyId, filters.policyId));
  if (filters.outcome) conditions.push(eq(guardThreats.outcome, filters.outcome));
  const search = filters.search?.trim();
  if (search) {
    const number = Number(search.replace(/^THR-/i, ''));
    const parts = [];
    if (Number.isInteger(number) && number > 0) parts.push(eq(guardThreats.displayNumber, number));
    if (uuidPattern.test(search)) parts.push(eq(guardThreats.requestId, search));
    parts.push(ilike(guardThreats.systemName, `%${search.slice(0, 80)}%`));
    parts.push(ilike(guardThreats.policyName, `%${search.slice(0, 80)}%`));
    const searchCondition = or(...parts);
    if (searchCondition) conditions.push(searchCondition);
  }
  return conditions;
}

export async function listGuardThreats(db: AppDatabase, organisationId: string, filters: GuardThreatFilters = {}) {
  requireOrganisationId(organisationId);
  const page = pageOf(filters.page);
  return usingTenant(db, organisationId, async (tx) => {
    const where = and(...threatConditions(organisationId, filters));
    const totalRows = await tx.select({ total: sql<number>`count(*)::int` }).from(guardThreats).where(where);
    const rows = await tx
      .select()
      .from(guardThreats)
      .where(where)
      .orderBy(desc(guardThreats.lastSeenAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { rows, total: Number(totalRows[0]?.total ?? 0), page, pageSize };
  });
}

export async function getGuardThreat(db: AppDatabase, organisationId: string, threatId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const threats = await tx
      .select()
      .from(guardThreats)
      .where(and(eq(guardThreats.organisationId, organisationId), eq(guardThreats.id, threatId)))
      .limit(1);
    const threat = threats[0];
    if (!threat) return null;
    const occurrences = await tx
      .select({
        eventId: guardEvents.id,
        occurredAt: guardEvents.occurredAt,
        requestId: guardEvents.requestId,
        provider: guardEvents.provider,
        model: guardEvents.model,
        actionTaken: guardEvents.actionTaken,
        outcome: sql<string>`coalesce(${guardEvents.evidenceJson}->>'outcome', '')`,
        classification: sql<string>`coalesce(${guardEvents.evidenceJson}->>'classification', '')`,
        matchCount: sql<string>`coalesce(${guardEvents.evidenceJson}->>'matchCount', '')`,
        redactionSummary: sql<string>`coalesce(${guardEvents.evidenceJson}->>'redactionSummary', '')`,
        decisionId: guardEvents.decisionId,
        policyId: guardEvents.policyId,
        policyVersion: guardEvents.policyVersion,
      })
      .from(guardThreatEvents)
      .innerJoin(guardEvents, and(eq(guardEvents.id, guardThreatEvents.eventId), eq(guardEvents.organisationId, organisationId)))
      .where(and(eq(guardThreatEvents.organisationId, organisationId), eq(guardThreatEvents.threatId, threatId)))
      .orderBy(desc(guardThreatEvents.occurredAt))
      .limit(100);
    const activity = await tx
      .select()
      .from(guardThreatActivity)
      .where(and(eq(guardThreatActivity.organisationId, organisationId), eq(guardThreatActivity.threatId, threatId)))
      .orderBy(asc(guardThreatActivity.createdAt));
    const since = new Date(threat.lastSeenAt.getTime() - 24 * 60 * 60 * 1000);
    const related = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(guardEvents)
      .where(
        and(
          eq(guardEvents.organisationId, organisationId),
          gte(guardEvents.occurredAt, since),
          lt(guardEvents.occurredAt, new Date(threat.lastSeenAt.getTime() + 1)),
          threat.aiSystemId ? eq(guardEvents.aiSystemId, threat.aiSystemId) : sql`false`,
          threat.classification ? sql`${guardEvents.evidenceJson}->>'classification' = ${threat.classification}` : sql`true`,
          sql`${guardEvents.id} not in (select event_id from guard_threat_events where threat_id = ${threatId})`,
        ),
      );
    const incidents = await tx
      .select({ id: guardIncidents.id, title: guardIncidents.title, displayNumber: guardIncidents.displayNumber, status: guardIncidents.status })
      .from(guardIncidentThreats)
      .innerJoin(guardIncidents, and(eq(guardIncidents.id, guardIncidentThreats.incidentId), eq(guardIncidents.organisationId, organisationId)))
      .where(and(eq(guardIncidentThreats.organisationId, organisationId), eq(guardIncidentThreats.threatId, threatId)));
    return {
      threat,
      label: formatGuardSequence('THR', threat.displayNumber),
      explanation: explainGuardThreat({
        type: threat.type as GuardThreatType,
        systemName: threat.systemName,
        policyName: threat.policyName,
        policyVersion: threat.policyVersion,
        classifications: threat.classification.split(',').filter(Boolean),
        outcome: threat.outcome,
        redactionSummary: threat.redactionSummary,
        enforcementExecuted: threat.outcome === 'blocked' || threat.outcome === 'redacted',
      }),
      occurrences,
      activity,
      relatedEvents: Number(related[0]?.total ?? 0),
      incidents,
    };
  });
}

export async function updateGuardThreatStatus(
  db: AppDatabase,
  organisationId: string,
  input: { threatId: string; actorUserId: string; status: GuardThreatStatus; reason?: string },
) {
  requireOrganisationId(organisationId);
  if (!guardThreatStatuses.includes(input.status)) throw new Error('Unknown threat status.');
  if ((input.status === 'dismissed' || input.status === 'expected') && !input.reason?.trim()) {
    throw new Error('A reason is required.');
  }
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardThreats)
      .where(and(eq(guardThreats.organisationId, organisationId), eq(guardThreats.id, input.threatId)))
      .limit(1);
    const threat = rows[0];
    if (!threat) return null;
    const reason = input.reason ? noteText(input.reason) : '';
    const summary = reason ? `${input.status}: ${reason}` : input.status;
    await tx
      .update(guardThreats)
      .set({ status: input.status, updatedAt: new Date() })
      .where(and(eq(guardThreats.organisationId, organisationId), eq(guardThreats.id, threat.id)));
    await tx.insert(guardThreatActivity).values({
      id: randomUUID(),
      organisationId,
      threatId: threat.id,
      kind: 'status',
      summary: sanitizeGuardText(summary, 500),
      actorUserId: input.actorUserId,
    });
    await writeAudit(tx, {
      organisationId,
      actorUserId: input.actorUserId,
      action: auditActions.guardThreatStatusChanged,
      resourceType: 'guard_threat',
      resourceId: threat.id,
      summary: input.status,
    });
    return threat.id;
  });
}

export async function assignGuardThreat(
  db: AppDatabase,
  organisationId: string,
  input: { threatId: string; actorUserId: string; assigneeUserId: string | null },
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    if (input.assigneeUserId) {
      const member = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.organisationId, organisationId), eq(users.id, input.assigneeUserId)))
        .limit(1);
      if (!member[0]) throw new Error('That user is not in this organisation.');
    }
    const rows = await tx
      .select()
      .from(guardThreats)
      .where(and(eq(guardThreats.organisationId, organisationId), eq(guardThreats.id, input.threatId)))
      .limit(1);
    if (!rows[0]) return null;
    await tx
      .update(guardThreats)
      .set({ assignedTo: input.assigneeUserId, updatedAt: new Date() })
      .where(and(eq(guardThreats.organisationId, organisationId), eq(guardThreats.id, input.threatId)));
    await tx.insert(guardThreatActivity).values({
      id: randomUUID(),
      organisationId,
      threatId: input.threatId,
      kind: 'assignment',
      summary: input.assigneeUserId ? 'Owner assigned' : 'Owner cleared',
      actorUserId: input.actorUserId,
    });
    await writeAudit(tx, {
      organisationId,
      actorUserId: input.actorUserId,
      action: auditActions.guardThreatAssigned,
      resourceType: 'guard_threat',
      resourceId: input.threatId,
      summary: input.assigneeUserId ? 'assigned' : 'unassigned',
    });
    return input.threatId;
  });
}

export async function listGuardOrganisationUsers(db: AppDatabase, organisationId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) =>
    tx
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(and(eq(users.organisationId, organisationId), eq(users.status, 'active')))
      .orderBy(asc(users.name)),
  );
}

export interface GuardIncidentFilters {
  status?: string;
  severity?: string;
  ownerUserId?: string;
  aiSystemId?: string;
  start?: Date;
  end?: Date;
  page?: number;
}

export async function listGuardIncidentCases(db: AppDatabase, organisationId: string, filters: GuardIncidentFilters = {}) {
  requireOrganisationId(organisationId);
  const page = pageOf(filters.page);
  return usingTenant(db, organisationId, async (tx) => {
    const conditions = [eq(guardIncidents.organisationId, organisationId)];
    if (filters.status) conditions.push(eq(guardIncidents.status, filters.status));
    if (filters.severity) conditions.push(eq(guardIncidents.severity, filters.severity));
    if (filters.ownerUserId) conditions.push(eq(guardIncidents.ownerUserId, filters.ownerUserId));
    if (filters.start) conditions.push(gte(guardIncidents.createdAt, filters.start));
    if (filters.end) conditions.push(lt(guardIncidents.createdAt, filters.end));
    if (filters.aiSystemId) {
      conditions.push(
        sql`exists (
          select 1 from guard_incident_threats link
          join guard_threats threat on threat.id = link.threat_id and threat.organisation_id = ${organisationId}
          where link.incident_id = ${guardIncidents.id} and threat.ai_system_id = ${filters.aiSystemId}
        )`,
      );
    }
    const where = and(...conditions);
    const totalRows = await tx.select({ total: sql<number>`count(*)::int` }).from(guardIncidents).where(where);
    const rows = await tx
      .select()
      .from(guardIncidents)
      .where(where)
      .orderBy(desc(guardIncidents.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const ids = rows.map((row) => row.id);
    const links = ids.length
      ? await tx
          .select({
            incidentId: guardIncidentThreats.incidentId,
            systemName: guardThreats.systemName,
            threatId: guardThreats.id,
          })
          .from(guardIncidentThreats)
          .innerJoin(guardThreats, and(eq(guardThreats.id, guardIncidentThreats.threatId), eq(guardThreats.organisationId, organisationId)))
          .where(and(eq(guardIncidentThreats.organisationId, organisationId), inArray(guardIncidentThreats.incidentId, ids)))
      : [];
    const owners = [...new Set(rows.map((row) => row.ownerUserId).filter((id): id is string => Boolean(id)))];
    const people = owners.length
      ? await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(and(eq(users.organisationId, organisationId), inArray(users.id, owners)))
      : [];
    const ownerName = new Map(people.map((person) => [person.id, person.name]));
    return {
      rows: rows.map((row) => {
        const related = links.filter((link) => link.incidentId === row.id);
        return {
          ...row,
          label: formatGuardSequence('INC', row.displayNumber),
          ownerName: row.ownerUserId ? (ownerName.get(row.ownerUserId) ?? 'Unknown user') : 'Unassigned',
          systems: [...new Set(related.map((link) => link.systemName).filter((name): name is string => Boolean(name)))],
          threatCount: new Set(related.map((link) => link.threatId)).size,
        };
      }),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  });
}

async function incidentOrNull(tx: AppDatabase, organisationId: string, incidentId: string) {
  const rows = await tx
    .select()
    .from(guardIncidents)
    .where(and(eq(guardIncidents.organisationId, organisationId), eq(guardIncidents.id, incidentId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createGuardIncident(
  db: AppDatabase,
  organisationId: string,
  input: {
    actorUserId: string;
    title: string;
    description?: string;
    severity: GuardThreatSeverity;
    threatId?: string | null;
    eventId?: string | null;
  },
) {
  requireOrganisationId(organisationId);
  const title = noteText(input.title);
  if (title.length < 3) throw new Error('Incident title is required.');
  return usingTenant(db, organisationId, async (tx) => {
    const displayNumber = await nextDisplayNumber(tx, organisationId, 'incident');
    const id = randomUUID();
    const now = new Date();
    await tx.insert(guardIncidents).values({
      id,
      organisationId,
      title,
      description: noteText(input.description ?? ''),
      summary: noteText(input.description ?? ''),
      severity: input.severity,
      status: 'open',
      createdBy: input.actorUserId,
      displayNumber,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(guardIncidentTimeline).values({
      id: randomUUID(),
      organisationId,
      incidentId: id,
      kind: 'created',
      summary: 'Incident created',
      actorUserId: input.actorUserId,
      createdAt: now,
    });
    if (input.threatId) await linkThreat(tx, organisationId, id, input.threatId, input.actorUserId);
    if (input.eventId) await linkEvent(tx, organisationId, id, input.eventId, input.actorUserId);
    await writeAudit(tx, {
      organisationId,
      actorUserId: input.actorUserId,
      action: auditActions.guardIncidentCreated,
      resourceType: 'guard_incident',
      resourceId: id,
      summary: formatGuardSequence('INC', displayNumber),
    });
    return id;
  });
}

async function linkThreat(tx: AppDatabase, organisationId: string, incidentId: string, threatId: string, actorUserId: string) {
  const threats = await tx
    .select({ id: guardThreats.id, title: guardThreats.title })
    .from(guardThreats)
    .where(and(eq(guardThreats.organisationId, organisationId), eq(guardThreats.id, threatId)))
    .limit(1);
  if (!threats[0]) throw new Error('Threat was not found in this organisation.');
  await tx
    .insert(guardIncidentThreats)
    .values({ organisationId, incidentId, threatId })
    .onConflictDoNothing();
  await tx.insert(guardIncidentTimeline).values({
    id: randomUUID(),
    organisationId,
    incidentId,
    kind: 'threat_attached',
    summary: `Threat attached: ${threats[0].title}`,
    actorUserId,
  });
}

async function linkEvent(tx: AppDatabase, organisationId: string, incidentId: string, eventId: string, actorUserId: string) {
  const events = await tx
    .select({ id: guardEvents.id, title: guardEvents.title })
    .from(guardEvents)
    .where(and(eq(guardEvents.organisationId, organisationId), eq(guardEvents.id, eventId)))
    .limit(1);
  if (!events[0]) throw new Error('Event was not found in this organisation.');
  await tx.insert(guardIncidentEvents).values({ organisationId, incidentId, eventId }).onConflictDoNothing();
  await tx.insert(guardIncidentTimeline).values({
    id: randomUUID(),
    organisationId,
    incidentId,
    kind: 'event_attached',
    summary: 'Guard event attached',
    actorUserId,
  });
}

export async function attachGuardIncidentThreat(
  db: AppDatabase,
  organisationId: string,
  input: { incidentId: string; threatId: string; actorUserId: string },
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const incident = await incidentOrNull(tx, organisationId, input.incidentId);
    if (!incident) return null;
    await linkThreat(tx, organisationId, incident.id, input.threatId, input.actorUserId);
    await tx.update(guardIncidents).set({ updatedAt: new Date() }).where(eq(guardIncidents.id, incident.id));
    return incident.id;
  });
}

export async function attachGuardIncidentEvent(
  db: AppDatabase,
  organisationId: string,
  input: { incidentId: string; eventId: string; actorUserId: string },
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const incident = await incidentOrNull(tx, organisationId, input.incidentId);
    if (!incident) return null;
    await linkEvent(tx, organisationId, incident.id, input.eventId, input.actorUserId);
    await tx.update(guardIncidents).set({ updatedAt: new Date() }).where(eq(guardIncidents.id, incident.id));
    return incident.id;
  });
}

export async function assignGuardIncident(
  db: AppDatabase,
  organisationId: string,
  input: { incidentId: string; actorUserId: string; assigneeUserId: string | null },
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const incident = await incidentOrNull(tx, organisationId, input.incidentId);
    if (!incident) return null;
    let name = 'Unassigned';
    if (input.assigneeUserId) {
      const member = await tx
        .select({ name: users.name })
        .from(users)
        .where(and(eq(users.organisationId, organisationId), eq(users.id, input.assigneeUserId)))
        .limit(1);
      if (!member[0]) throw new Error('That user is not in this organisation.');
      name = member[0].name;
    }
    await tx
      .update(guardIncidents)
      .set({ ownerUserId: input.assigneeUserId, updatedAt: new Date() })
      .where(and(eq(guardIncidents.organisationId, organisationId), eq(guardIncidents.id, incident.id)));
    await tx.insert(guardIncidentTimeline).values({
      id: randomUUID(),
      organisationId,
      incidentId: incident.id,
      kind: 'owner_changed',
      summary: `Owner changed to ${name}`,
      actorUserId: input.actorUserId,
    });
    await writeAudit(tx, {
      organisationId,
      actorUserId: input.actorUserId,
      action: auditActions.guardIncidentAssigned,
      resourceType: 'guard_incident',
      resourceId: incident.id,
      summary: input.assigneeUserId ? 'assigned' : 'unassigned',
    });
    return incident.id;
  });
}

export async function addGuardIncidentNote(
  db: AppDatabase,
  organisationId: string,
  input: { incidentId: string; actorUserId: string; body: string },
) {
  requireOrganisationId(organisationId);
  const body = noteText(input.body);
  if (!body) throw new Error('Note text is required.');
  return usingTenant(db, organisationId, async (tx) => {
    const incident = await incidentOrNull(tx, organisationId, input.incidentId);
    if (!incident) return null;
    await tx.insert(guardIncidentNotes).values({
      id: randomUUID(),
      organisationId,
      incidentId: incident.id,
      authorUserId: input.actorUserId,
      body,
    });
    await tx.insert(guardIncidentTimeline).values({
      id: randomUUID(),
      organisationId,
      incidentId: incident.id,
      kind: 'note_added',
      summary: 'Investigation note added',
      actorUserId: input.actorUserId,
    });
    await tx.update(guardIncidents).set({ updatedAt: new Date() }).where(eq(guardIncidents.id, incident.id));
    return incident.id;
  });
}

export async function updateGuardIncidentStatus(
  db: AppDatabase,
  organisationId: string,
  input: { incidentId: string; actorUserId: string; status: string; resolution?: string; followUp?: string },
) {
  requireOrganisationId(organisationId);
  if (!['open', 'investigating', 'contained', 'resolved', 'dismissed'].includes(input.status)) {
    throw new Error('Unknown incident status.');
  }
  if ((input.status === 'resolved' || input.status === 'dismissed') && !input.resolution?.trim()) {
    throw new Error('A resolution summary is required.');
  }
  return usingTenant(db, organisationId, async (tx) => {
    const incident = await incidentOrNull(tx, organisationId, input.incidentId);
    if (!incident) return null;
    const now = new Date();
    const resolution = input.resolution ? noteText(input.resolution) : incident.resolution;
    const followUp = input.followUp ? noteText(input.followUp) : incident.followUp;
    await tx
      .update(guardIncidents)
      .set({
        status: input.status,
        resolution,
        followUp,
        resolvedAt: input.status === 'resolved' || input.status === 'dismissed' ? now : null,
        updatedAt: now,
      })
      .where(and(eq(guardIncidents.organisationId, organisationId), eq(guardIncidents.id, incident.id)));
    await tx.insert(guardIncidentTimeline).values({
      id: randomUUID(),
      organisationId,
      incidentId: incident.id,
      kind: input.status === 'resolved' || input.status === 'dismissed' ? 'resolved' : 'status_changed',
      summary: input.status === 'resolved' || input.status === 'dismissed' ? `Resolution recorded: ${resolution}` : `Status changed to ${input.status}`,
      actorUserId: input.actorUserId,
    });
    await writeAudit(tx, {
      organisationId,
      actorUserId: input.actorUserId,
      action: auditActions.guardIncidentStatusChanged,
      resourceType: 'guard_incident',
      resourceId: incident.id,
      summary: input.status,
    });
    return incident.id;
  });
}

export async function getGuardIncident(db: AppDatabase, organisationId: string, incidentId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const incident = await incidentOrNull(tx, organisationId, incidentId);
    if (!incident) return null;
    const threats = await tx
      .select()
      .from(guardIncidentThreats)
      .innerJoin(guardThreats, and(eq(guardThreats.id, guardIncidentThreats.threatId), eq(guardThreats.organisationId, organisationId)))
      .where(and(eq(guardIncidentThreats.organisationId, organisationId), eq(guardIncidentThreats.incidentId, incidentId)));
    const events = await tx
      .select({
        id: guardEvents.id,
        title: guardEvents.title,
        occurredAt: guardEvents.occurredAt,
        eventType: guardEvents.eventType,
        actionTaken: guardEvents.actionTaken,
        policyName: guardEvents.policyName,
        policyId: guardEvents.policyId,
        policyVersion: guardEvents.policyVersion,
        decisionId: guardEvents.decisionId,
        requestId: guardEvents.requestId,
        outcome: sql<string>`coalesce(${guardEvents.evidenceJson}->>'outcome', '')`,
        classification: sql<string>`coalesce(${guardEvents.evidenceJson}->>'classification', '')`,
      })
      .from(guardIncidentEvents)
      .innerJoin(guardEvents, and(eq(guardEvents.id, guardIncidentEvents.eventId), eq(guardEvents.organisationId, organisationId)))
      .where(and(eq(guardIncidentEvents.organisationId, organisationId), eq(guardIncidentEvents.incidentId, incidentId)))
      .orderBy(desc(guardEvents.occurredAt));
    const notes = await tx
      .select({
        id: guardIncidentNotes.id,
        body: guardIncidentNotes.body,
        createdAt: guardIncidentNotes.createdAt,
        author: users.name,
      })
      .from(guardIncidentNotes)
      .innerJoin(users, and(eq(users.id, guardIncidentNotes.authorUserId), eq(users.organisationId, organisationId)))
      .where(and(eq(guardIncidentNotes.organisationId, organisationId), eq(guardIncidentNotes.incidentId, incidentId)))
      .orderBy(asc(guardIncidentNotes.createdAt));
    const timeline = await tx
      .select()
      .from(guardIncidentTimeline)
      .where(and(eq(guardIncidentTimeline.organisationId, organisationId), eq(guardIncidentTimeline.incidentId, incidentId)))
      .orderBy(asc(guardIncidentTimeline.createdAt));
    const owner = incident.ownerUserId
      ? await tx
          .select({ name: users.name })
          .from(users)
          .where(and(eq(users.organisationId, organisationId), eq(users.id, incident.ownerUserId)))
          .limit(1)
      : [];
    const threatRows = threats.map((row) => row.guard_threats);
    const redacted = events.filter((event) => event.outcome === 'redacted').length;
    const observed = events.filter((event) => event.outcome === 'would_enforce').length;
    const systems = [...new Set(threatRows.map((threat) => threat.systemName).filter((name): name is string => Boolean(name)))];
    const policies = [
      ...new Map(
        threatRows
          .filter((threat) => threat.policyId)
          .map((threat) => [threat.policyId, { id: threat.policyId as string, name: threat.policyName, version: threat.policyVersion }]),
      ).values(),
    ];
    return {
      incident,
      label: formatGuardSequence('INC', incident.displayNumber),
      ownerName: owner[0]?.name ?? 'Unassigned',
      threats: threatRows,
      events,
      notes,
      timeline,
      systems,
      policies,
      summary: {
        events: events.length,
        redacted,
        observed,
        first: events[events.length - 1]?.occurredAt ?? null,
        last: events[0]?.occurredAt ?? null,
      },
    };
  });
}

export async function getGuardDataSecurity(
  db: AppDatabase,
  organisationId: string,
  range: { start: Date; end: Date },
) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const where = and(
      eq(guardEvents.organisationId, organisationId),
      gte(guardEvents.occurredAt, range.start),
      lt(guardEvents.occurredAt, range.end),
    );
    const totals = await tx
      .select({
        sensitiveEvents: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'sensitive_data')::int`,
        sensitiveRequests: sql<number>`count(distinct ${guardEvents.requestId}) filter (where ${guardEvents.eventType} = 'sensitive_data' and ${guardEvents.requestId} is not null)::int`,
        blockedRequests: sql<number>`count(distinct ${guardEvents.requestId}) filter (where ${guardEvents.eventType} = 'blocked_request' and coalesce(${guardEvents.evidenceJson}->>'classification', '') <> '')::int`,
        systems: sql<number>`count(distinct ${guardEvents.aiSystemId}) filter (where ${guardEvents.eventType} = 'sensitive_data' and ${guardEvents.aiSystemId} is not null)::int`,
      })
      .from(guardEvents)
      .where(where);
    const redactionGroups = await tx
      .select({
        summary: sql<string>`coalesce(${guardEvents.evidenceJson}->>'redactionSummary', '')`,
        total: sql<number>`count(*)::int`,
      })
      .from(guardEvents)
      .where(and(where, eq(guardEvents.eventType, 'redacted_request')))
      .groupBy(sql`${guardEvents.evidenceJson}->>'redactionSummary'`);
    let valuesRedacted = 0;
    for (const group of redactionGroups) {
      const counts = String(group.summary)
        .split(',')
        .map((part) => Number(part.split('=')[1]))
        .filter((value) => Number.isInteger(value) && value > 0);
      const perEvent = counts.reduce((sum, value) => sum + value, 0);
      valuesRedacted += perEvent * Number(group.total);
    }
    const byClassification = await tx
      .select({
        classification: sql<string>`coalesce(${guardEvents.evidenceJson}->>'classification', '')`,
        outcome: sql<string>`coalesce(${guardEvents.evidenceJson}->>'outcome', '')`,
        total: sql<number>`count(*)::int`,
      })
      .from(guardEvents)
      .where(and(where, eq(guardEvents.eventType, 'sensitive_data')))
      .groupBy(sql`${guardEvents.evidenceJson}->>'classification'`, sql`${guardEvents.evidenceJson}->>'outcome'`);
    const bySystem = await tx
      .select({
        aiSystemId: guardEvents.aiSystemId,
        total: sql<number>`count(*)::int`,
      })
      .from(guardEvents)
      .where(and(where, eq(guardEvents.eventType, 'sensitive_data')))
      .groupBy(guardEvents.aiSystemId);
    const byProvider = await tx
      .select({
        provider: guardEvents.provider,
        model: guardEvents.model,
        total: sql<number>`count(*)::int`,
      })
      .from(guardEvents)
      .where(and(where, eq(guardEvents.eventType, 'sensitive_data')))
      .groupBy(guardEvents.provider, guardEvents.model);
    const byPolicy = await tx
      .select({
        policyId: guardEvents.policyId,
        policyName: guardEvents.policyName,
        policyVersion: guardEvents.policyVersion,
        total: sql<number>`count(*)::int`,
      })
      .from(guardEvents)
      .where(and(where, eq(guardEvents.eventType, 'sensitive_data')))
      .groupBy(guardEvents.policyId, guardEvents.policyName, guardEvents.policyVersion);
    const byEnvironment = await tx
      .select({
        environmentId: guardEvents.environmentId,
        total: sql<number>`count(*)::int`,
      })
      .from(guardEvents)
      .where(and(where, eq(guardEvents.eventType, 'sensitive_data')))
      .groupBy(guardEvents.environmentId);
    const flow = await tx
      .select({
        aiSystemId: guardEvents.aiSystemId,
        provider: guardEvents.provider,
        model: guardEvents.model,
        policyId: guardEvents.policyId,
        policyName: guardEvents.policyName,
        policyVersion: guardEvents.policyVersion,
        classification: sql<string>`coalesce(${guardEvents.evidenceJson}->>'classification', '')`,
        outcome: sql<string>`coalesce(${guardEvents.evidenceJson}->>'outcome', '')`,
        total: sql<number>`count(*)::int`,
      })
      .from(guardEvents)
      .where(and(where, inArray(guardEvents.eventType, ['sensitive_data', 'redacted_request', 'blocked_request'])))
      .groupBy(
        guardEvents.aiSystemId,
        guardEvents.provider,
        guardEvents.model,
        guardEvents.policyId,
        guardEvents.policyName,
        guardEvents.policyVersion,
        sql`${guardEvents.evidenceJson}->>'classification'`,
        sql`${guardEvents.evidenceJson}->>'outcome'`,
      )
      .orderBy(desc(sql`count(*)`))
      .limit(40);
    const systemIds = [...new Set([...bySystem, ...flow].map((row) => row.aiSystemId).filter((id): id is string => Boolean(id)))];
    const names = systemIds.length
      ? await tx
          .select({ id: aiSystems.id, name: aiSystems.name })
          .from(aiSystems)
          .where(and(eq(aiSystems.organisationId, organisationId), inArray(aiSystems.id, systemIds)))
      : [];
    const environmentIds = byEnvironment.map((row) => row.environmentId).filter((id): id is string => Boolean(id));
    const environmentRows = environmentIds.length
      ? await tx
          .select({ id: environments.id, name: environments.name, type: environments.type })
          .from(environments)
          .where(and(eq(environments.organisationId, organisationId), inArray(environments.id, environmentIds)))
      : [];
    return {
      sensitiveEvents: Number(totals[0]?.sensitiveEvents ?? 0),
      sensitiveRequests: Number(totals[0]?.sensitiveRequests ?? 0),
      valuesRedacted,
      blockedRequests: Number(totals[0]?.blockedRequests ?? 0),
      systems: Number(totals[0]?.systems ?? 0),
      byClassification,
      bySystem: bySystem.map((row) => ({
        ...row,
        name: names.find((system) => system.id === row.aiSystemId)?.name ?? 'Unknown system',
        total: Number(row.total),
      })),
      byProvider: byProvider.map((row) => ({ ...row, total: Number(row.total) })),
      byPolicy: byPolicy.map((row) => ({ ...row, total: Number(row.total) })),
      byEnvironment: byEnvironment.map((row) => ({
        ...row,
        name: environmentRows.find((environment) => environment.id === row.environmentId)?.name ?? 'Unknown environment',
        total: Number(row.total),
      })),
      flow: flow.map((row) => ({
        ...row,
        systemName: names.find((system) => system.id === row.aiSystemId)?.name ?? 'Unknown system',
        total: Number(row.total),
      })),
    };
  });
}

export async function getGuardSecurityAttention(db: AppDatabase, organisationId: string, range: { start: Date; end: Date }) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const threats = await tx
      .select({
        open: sql<number>`count(*) filter (where ${guardThreats.status} in ('open', 'investigating', 'contained'))::int`,
        high: sql<number>`count(*) filter (where ${guardThreats.status} in ('open', 'investigating', 'contained') and ${guardThreats.severity} in ('high', 'critical'))::int`,
      })
      .from(guardThreats)
      .where(eq(guardThreats.organisationId, organisationId));
    const incidents = await tx
      .select({
        open: sql<number>`count(*) filter (where ${guardIncidents.status} in ('open', 'investigating', 'contained'))::int`,
        stale: sql<number>`count(*) filter (where ${guardIncidents.status} = 'investigating' and ${guardIncidents.updatedAt} < now() - interval '3 days')::int`,
      })
      .from(guardIncidents)
      .where(eq(guardIncidents.organisationId, organisationId));
    const events = await tx
      .select({
        sensitive: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'sensitive_data')::int`,
        blocked: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'blocked_request')::int`,
        redacted: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'redacted_request')::int`,
        runtime: sql<number>`count(*) filter (where ${guardEvents.eventType} = 'runtime_alert')::int`,
      })
      .from(guardEvents)
      .where(and(eq(guardEvents.organisationId, organisationId), gte(guardEvents.occurredAt, range.start), lt(guardEvents.occurredAt, range.end)));
    const systems = await tx
      .select({
        aiSystemId: guardThreats.aiSystemId,
        name: guardThreats.systemName,
        highThreats: sql<number>`count(*) filter (where ${guardThreats.severity} in ('high', 'critical') and ${guardThreats.status} in ('open', 'investigating', 'contained'))::int`,
        sensitive: sql<number>`count(*) filter (where ${guardThreats.type} = 'sensitive_data_exposure')::int`,
      })
      .from(guardThreats)
      .where(and(eq(guardThreats.organisationId, organisationId), sql`${guardThreats.aiSystemId} is not null`))
      .groupBy(guardThreats.aiSystemId, guardThreats.systemName)
      .orderBy(desc(sql`count(*) filter (where ${guardThreats.severity} in ('high', 'critical') and ${guardThreats.status} in ('open', 'investigating', 'contained'))`))
      .limit(5);
    return {
      openThreats: Number(threats[0]?.open ?? 0),
      highThreats: Number(threats[0]?.high ?? 0),
      openIncidents: Number(incidents[0]?.open ?? 0),
      staleInvestigations: Number(incidents[0]?.stale ?? 0),
      sensitiveEvents: Number(events[0]?.sensitive ?? 0),
      blockedRequests: Number(events[0]?.blocked ?? 0),
      redactedRequests: Number(events[0]?.redacted ?? 0),
      runtimeErrors: Number(events[0]?.runtime ?? 0),
      systems: systems.map((system) => ({
        id: system.aiSystemId as string,
        name: system.name ?? 'Unknown system',
        highThreats: Number(system.highThreats),
        sensitive: Number(system.sensitive),
      })),
    };
  });
}

export async function getGuardRequestActivity(db: AppDatabase, organisationId: string, requestId: string) {
  requireOrganisationId(organisationId);
  if (!uuidPattern.test(requestId)) return { events: [], decisions: [] };
  return usingTenant(db, organisationId, async (tx) => {
    const events = await tx
      .select({
        id: guardEvents.id,
        title: guardEvents.title,
        eventType: guardEvents.eventType,
        occurredAt: guardEvents.occurredAt,
        outcome: sql<string>`coalesce(${guardEvents.evidenceJson}->>'outcome', '')`,
      })
      .from(guardEvents)
      .where(and(eq(guardEvents.organisationId, organisationId), eq(guardEvents.requestId, requestId)))
      .orderBy(asc(guardEvents.occurredAt));
    const decisions = await tx
      .select({
        id: guardDecisions.id,
        decision: guardDecisions.decision,
        evaluatedAt: guardDecisions.evaluatedAt,
        policiesConsidered: guardDecisions.policiesConsidered,
        policiesMatched: guardDecisions.policiesMatched,
        outcome: sql<string>`coalesce(${guardDecisions.contextSummary}->>'outcome', '')`,
        invoked: sql<string>`coalesce(${guardDecisions.contextSummary}->>'enforcementExecuted', '')`,
      })
      .from(guardDecisions)
      .where(and(eq(guardDecisions.organisationId, organisationId), eq(guardDecisions.traceId, requestId)))
      .orderBy(asc(guardDecisions.evaluatedAt));
    return { events, decisions };
  });
}

export async function findGuardIncidentForEvent(db: AppDatabase, organisationId: string, eventId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select({ incidentId: guardIncidentEvents.incidentId, displayNumber: guardIncidents.displayNumber })
      .from(guardIncidentEvents)
      .innerJoin(guardIncidents, and(eq(guardIncidents.id, guardIncidentEvents.incidentId), eq(guardIncidents.organisationId, organisationId)))
      .where(and(eq(guardIncidentEvents.organisationId, organisationId), eq(guardIncidentEvents.eventId, eventId)))
      .limit(1);
    return rows[0] ? { id: rows[0].incidentId, label: formatGuardSequence('INC', rows[0].displayNumber) } : null;
  });
}

export async function findGuardThreatForEvent(db: AppDatabase, organisationId: string, eventId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select({ threatId: guardThreatEvents.threatId, displayNumber: guardThreats.displayNumber })
      .from(guardThreatEvents)
      .innerJoin(guardThreats, and(eq(guardThreats.id, guardThreatEvents.threatId), eq(guardThreats.organisationId, organisationId)))
      .where(and(eq(guardThreatEvents.organisationId, organisationId), eq(guardThreatEvents.eventId, eventId)))
      .limit(1);
    return rows[0] ? { id: rows[0].threatId, label: formatGuardSequence('THR', rows[0].displayNumber) } : null;
  });
}

export function threatIsKnownType(value: string): value is GuardThreatType {
  return (guardThreatTypes as readonly string[]).includes(value);
}

export type { ThreatRow, IncidentRow };
