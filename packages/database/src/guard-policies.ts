import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { auditActions, safeAuditMetadata } from '@vhalcha/audit';
import {
  evaluatePolicies,
  guardLiveEnforcement,
  guardPolicyCategories,
  guardPolicyModes,
  invalidatePolicyCache,
  readPolicyCache,
  sanitizeGuardText,
  summarizeEvaluationContext,
  summarizePolicyDocument,
  validatePolicyDocument,
  writePolicyCache,
  type CompiledGuardPolicy,
  type GuardDecision,
  type GuardEvaluationContext,
  type GuardPolicyCategory,
  type GuardPolicyDocument,
  type GuardPolicyMode,
  type GuardPolicyStatus,
} from '@vhalcha/guard';
import type { AppDatabase } from './client';
import {
  aiSystems,
  auditEvents,
  guardDecisions,
  guardPolicies,
  guardPolicyVersions,
  guardSettings,
  modelCatalogue,
  providerConnections,
} from './schema';
import { requireOrganisationId, usingTenant } from './tenant';

export interface GuardPolicyRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  status: GuardPolicyStatus;
  mode: GuardPolicyMode;
  priority: number;
  currentVersion: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  summary: string;
  document: GuardPolicyDocument;
  versionId: string;
}

function asStatus(value: string): GuardPolicyStatus {
  if (value === 'draft' || value === 'active' || value === 'disabled') return value;
  return 'draft';
}

function asMode(value: string): GuardPolicyMode {
  return value === 'enforce' ? 'enforce' : 'monitor';
}

function documentFromRow(row: {
  scope: Record<string, unknown>;
  conditions: Record<string, unknown>;
  actions: unknown[];
}): GuardPolicyDocument {
  return validatePolicyDocument({
    scope: row.scope as GuardPolicyDocument['scope'],
    conditions: row.conditions as unknown as GuardPolicyDocument['conditions'],
    actions: row.actions as GuardPolicyDocument['actions'],
  });
}

async function bumpPolicySet(tx: AppDatabase, organisationId: string): Promise<void> {
  const existing = await tx.select().from(guardSettings).where(eq(guardSettings.organisationId, organisationId)).limit(1);
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
      organisationLabel: 'standard',
      policySetVersion: 2,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  await tx
    .update(guardSettings)
    .set({ policySetVersion: existing[0].policySetVersion + 1, updatedAt: now })
    .where(eq(guardSettings.organisationId, organisationId));
}

async function auditPolicy(
  tx: AppDatabase,
  input: { organisationId: string; actorUserId: string; action: string; policyId: string; metadata: Record<string, unknown> },
) {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    organisationId: input.organisationId,
    environmentId: null,
    actorType: 'user',
    actorId: input.actorUserId,
    action: input.action,
    resourceType: 'guard_policy',
    resourceId: input.policyId,
    result: 'success',
    severity: 'info',
    requestId: null,
    metadataJson: safeAuditMetadata(
      Object.fromEntries(
        Object.entries(input.metadata).map(([key, value]) => [key, typeof value === 'string' ? sanitizeGuardText(value, 180) : value]),
      ),
    ),
    createdAt: new Date(),
  });
}

async function assertSystems(tx: AppDatabase, organisationId: string, systemIds: string[]) {
  if (systemIds.length === 0) return;
  const rows = await tx
    .select({ id: aiSystems.id })
    .from(aiSystems)
    .where(and(eq(aiSystems.organisationId, organisationId), inArray(aiSystems.id, systemIds)));
  if (rows.length !== new Set(systemIds).size) {
    throw new Error('AI system was not found in this organisation.');
  }
}

function mapPolicy(
  policy: typeof guardPolicies.$inferSelect,
  version: typeof guardPolicyVersions.$inferSelect,
): GuardPolicyRecord {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    category: policy.category,
    status: asStatus(policy.status),
    mode: asMode(policy.mode),
    priority: policy.priority,
    currentVersion: policy.currentVersion,
    createdBy: policy.createdBy,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
    summary: version.summary,
    document: documentFromRow(version),
    versionId: version.id,
  };
}

export async function listGuardPolicies(db: AppDatabase, organisationId: string, status?: GuardPolicyStatus) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const policies = await tx
      .select()
      .from(guardPolicies)
      .where(
        status
          ? and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.status, status))
          : eq(guardPolicies.organisationId, organisationId),
      )
      .orderBy(desc(guardPolicies.priority), guardPolicies.name);
    if (policies.length === 0) return [];
    const versions = await tx
      .select()
      .from(guardPolicyVersions)
      .where(eq(guardPolicyVersions.organisationId, organisationId));
    return policies.map((policy) => {
      const version = versions.find((item) => item.policyId === policy.id && item.version === policy.currentVersion);
      if (!version) throw new Error('Policy version is missing.');
      return mapPolicy(policy, version);
    });
  });
}

export async function getGuardPolicy(db: AppDatabase, organisationId: string, policyId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const policies = await tx
      .select()
      .from(guardPolicies)
      .where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.id, policyId)))
      .limit(1);
    const policy = policies[0];
    if (!policy) return null;
    const versions = await tx
      .select()
      .from(guardPolicyVersions)
      .where(and(eq(guardPolicyVersions.organisationId, organisationId), eq(guardPolicyVersions.policyId, policyId)))
      .orderBy(desc(guardPolicyVersions.version));
    const current = versions.find((version) => version.version === policy.currentVersion);
    if (!current) return null;
    const decisions = await tx
      .select()
      .from(guardDecisions)
      .where(
        and(
          eq(guardDecisions.organisationId, organisationId),
          sql`${guardDecisions.matchedPolicies} @> ${JSON.stringify([{ policyId }])}::jsonb`,
        ),
      )
      .orderBy(desc(guardDecisions.evaluatedAt))
      .limit(20);
    const audits = await tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organisationId, organisationId), eq(auditEvents.resourceId, policyId)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(30);
    return {
      policy: mapPolicy(policy, current),
      versions,
      decisions,
      audits: audits.filter((event) => event.action.startsWith('guard.policy.')),
    };
  });
}

function checkedDocument(input: {
  name: string;
  description?: string;
  category: string;
  mode: string;
  priority: number;
  document: GuardPolicyDocument;
  systemNames?: Map<string, string>;
}) {
  const category = guardPolicyCategories.find((item) => item === input.category);
  const mode = guardPolicyModes.find((item) => item === input.mode);
  if (!category || !mode) throw new Error('Policy category or mode is invalid.');
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 1000) {
    throw new Error('Priority must be between 1 and 1000.');
  }
  const name = sanitizeGuardText(input.name, 120);
  if (name.length < 3) throw new Error('Policy name is required.');
  const document = validatePolicyDocument(input.document);
  return {
    category,
    mode,
    name,
    description: sanitizeGuardText(input.description ?? '', 500),
    document,
    summary: summarizePolicyDocument(name, document, input.systemNames),
  };
}

export async function createGuardPolicy(
  db: AppDatabase,
  input: {
    organisationId: string;
    actorUserId: string;
    name: string;
    description?: string;
    category: GuardPolicyCategory;
    mode: GuardPolicyMode;
    priority: number;
    document: GuardPolicyDocument;
  },
) {
  requireOrganisationId(input.organisationId);
  return usingTenant(db, input.organisationId, async (tx) => {
    const names = await systemNameMap(tx, input.organisationId);
    const checked = checkedDocument({ ...input, systemNames: names });
    await assertSystems(tx, input.organisationId, checked.document.scope.systemIds ?? []);
    const now = new Date();
    const policyId = randomUUID();
    const versionId = randomUUID();
    await tx.insert(guardPolicies).values({
      id: policyId,
      organisationId: input.organisationId,
      name: checked.name,
      description: checked.description,
      category: checked.category,
      status: 'draft',
      mode: checked.mode,
      priority: input.priority,
      currentVersion: 1,
      createdBy: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(guardPolicyVersions).values({
      id: versionId,
      policyId,
      organisationId: input.organisationId,
      version: 1,
      scope: checked.document.scope as Record<string, unknown>,
      conditions: checked.document.conditions as unknown as Record<string, unknown>,
      actions: checked.document.actions as unknown[],
      summary: checked.summary,
      createdBy: input.actorUserId,
      createdAt: now,
    });
    await auditPolicy(tx, {
      organisationId: input.organisationId,
      actorUserId: input.actorUserId,
      action: auditActions.guardPolicyCreated,
      policyId,
      metadata: { name: checked.name, version: 1, mode: checked.mode },
    });
    return { policyId, versionId, version: 1 };
  });
}

export async function updateGuardPolicy(
  db: AppDatabase,
  input: {
    organisationId: string;
    actorUserId: string;
    policyId: string;
    name: string;
    description?: string;
    category: GuardPolicyCategory;
    mode: GuardPolicyMode;
    priority: number;
    document: GuardPolicyDocument;
  },
) {
  requireOrganisationId(input.organisationId);
  const result = await usingTenant(db, input.organisationId, async (tx) => {
    const existing = await tx
      .select()
      .from(guardPolicies)
      .where(and(eq(guardPolicies.organisationId, input.organisationId), eq(guardPolicies.id, input.policyId)))
      .limit(1);
    const policy = existing[0];
    if (!policy) throw new Error('Policy was not found in this organisation.');
    const names = await systemNameMap(tx, input.organisationId);
    const checked = checkedDocument({ ...input, systemNames: names });
    await assertSystems(tx, input.organisationId, checked.document.scope.systemIds ?? []);
    const nextVersion = policy.currentVersion + 1;
    const now = new Date();
    const versionId = randomUUID();
    await tx.insert(guardPolicyVersions).values({
      id: versionId,
      policyId: policy.id,
      organisationId: input.organisationId,
      version: nextVersion,
      scope: checked.document.scope as Record<string, unknown>,
      conditions: checked.document.conditions as unknown as Record<string, unknown>,
      actions: checked.document.actions as unknown[],
      summary: checked.summary,
      createdBy: input.actorUserId,
      createdAt: now,
    });
    await tx
      .update(guardPolicies)
      .set({
        name: checked.name,
        description: checked.description,
        category: checked.category,
        mode: checked.mode,
        priority: input.priority,
        currentVersion: nextVersion,
        updatedAt: now,
      })
      .where(and(eq(guardPolicies.organisationId, input.organisationId), eq(guardPolicies.id, policy.id)));
    await bumpPolicySet(tx, input.organisationId);
    await auditPolicy(tx, {
      organisationId: input.organisationId,
      actorUserId: input.actorUserId,
      action: auditActions.guardPolicyUpdated,
      policyId: policy.id,
      metadata: { from_version: policy.currentVersion, to_version: nextVersion, name: checked.name },
    });
    return { policyId: policy.id, versionId, version: nextVersion, previousVersion: policy.currentVersion };
  });
  invalidatePolicyCache(input.organisationId);
  return result;
}

export async function activateGuardPolicy(db: AppDatabase, organisationId: string, policyId: string, actorUserId: string) {
  requireOrganisationId(organisationId);
  await usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardPolicies)
      .where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.id, policyId)))
      .limit(1);
    const policy = rows[0];
    if (!policy) throw new Error('Policy was not found in this organisation.');
    if (policy.status === 'active') return;
    await tx
      .update(guardPolicies)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.id, policyId)));
    await bumpPolicySet(tx, organisationId);
    await auditPolicy(tx, {
      organisationId,
      actorUserId,
      action: auditActions.guardPolicyActivated,
      policyId,
      metadata: { version: policy.currentVersion, name: policy.name },
    });
  });
  invalidatePolicyCache(organisationId);
}

export async function disableGuardPolicy(db: AppDatabase, organisationId: string, policyId: string, actorUserId: string) {
  requireOrganisationId(organisationId);
  await usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardPolicies)
      .where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.id, policyId)))
      .limit(1);
    const policy = rows[0];
    if (!policy) throw new Error('Policy was not found in this organisation.');
    if (policy.status === 'disabled') return;
    await tx
      .update(guardPolicies)
      .set({ status: 'disabled', updatedAt: new Date() })
      .where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.id, policyId)));
    await bumpPolicySet(tx, organisationId);
    await auditPolicy(tx, {
      organisationId,
      actorUserId,
      action: auditActions.guardPolicyDisabled,
      policyId,
      metadata: { version: policy.currentVersion, name: policy.name },
    });
  });
  invalidatePolicyCache(organisationId);
}

export async function deleteGuardPolicy(db: AppDatabase, organisationId: string, policyId: string, actorUserId: string) {
  requireOrganisationId(organisationId);
  await usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardPolicies)
      .where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.id, policyId)))
      .limit(1);
    const policy = rows[0];
    if (!policy) throw new Error('Policy was not found in this organisation.');
    if (policy.status !== 'draft') throw new Error('Disable this policy instead of deleting it.');
    const used = await tx
      .select({ id: guardDecisions.id })
      .from(guardDecisions)
      .where(
        and(
          eq(guardDecisions.organisationId, organisationId),
          sql`${guardDecisions.matchedPolicies} @> ${JSON.stringify([{ policyId }])}::jsonb`,
        ),
      )
      .limit(1);
    if (used[0]) throw new Error('Disable this policy instead of deleting it.');
    await auditPolicy(tx, {
      organisationId,
      actorUserId,
      action: auditActions.guardPolicyDeleted,
      policyId,
      metadata: { name: policy.name, version: policy.currentVersion },
    });
    await tx.delete(guardPolicies).where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.id, policyId)));
  });
  invalidatePolicyCache(organisationId);
}

async function systemNameMap(tx: AppDatabase, organisationId: string) {
  const systems = await tx
    .select({ id: aiSystems.id, name: aiSystems.name })
    .from(aiSystems)
    .where(eq(aiSystems.organisationId, organisationId));
  return new Map(systems.map((system) => [system.id, system.name]));
}

export interface GuardPolicyCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

const guardPolicyCacheTtlSeconds = 60;

export function guardPolicyRedisKey(organizationId: string, policySetVersion: number) {
  return `guard:policies:${organizationId}:${policySetVersion}`;
}

async function loadActivePolicies(
  tx: AppDatabase,
  organisationId: string,
  cache?: GuardPolicyCacheStore,
): Promise<{ version: number; policies: CompiledGuardPolicy[]; loadMs: number }> {
  const started = performance.now();
  const settings = await tx.select().from(guardSettings).where(eq(guardSettings.organisationId, organisationId)).limit(1);
  const version = settings[0]?.policySetVersion ?? 1;
  const redisKey = guardPolicyRedisKey(organisationId, version);
  if (cache) {
    try {
      const raw = await cache.get(redisKey);
      if (raw) {
        const parsed = JSON.parse(raw) as CompiledGuardPolicy[];
        if (Array.isArray(parsed) && parsed.every((policy) => policy.organizationId === organisationId)) {
          writePolicyCache(organisationId, version, parsed);
          return { version, policies: parsed, loadMs: performance.now() - started };
        }
      }
    } catch {
      // Redis is a shared cache. Postgres remains the source of truth.
    }
  }
  const cached = readPolicyCache(organisationId, version);
  if (cached) return { version, policies: cached, loadMs: performance.now() - started };
  const policies = await tx
    .select()
    .from(guardPolicies)
    .where(and(eq(guardPolicies.organisationId, organisationId), eq(guardPolicies.status, 'active')));
  const versions = policies.length
    ? await tx.select().from(guardPolicyVersions).where(eq(guardPolicyVersions.organisationId, organisationId))
    : [];
  const compiled: CompiledGuardPolicy[] = policies.map((policy) => {
    const current = versions.find((item) => item.policyId === policy.id && item.version === policy.currentVersion);
    if (!current) throw new Error('Policy version is missing.');
    return {
      organizationId: organisationId,
      policyId: policy.id,
      policyVersionId: current.id,
      name: policy.name,
      version: current.version,
      priority: policy.priority,
      mode: asMode(policy.mode),
      document: documentFromRow(current),
    };
  });
  writePolicyCache(organisationId, version, compiled);
  if (cache) {
    try {
      await cache.set(redisKey, JSON.stringify(compiled), guardPolicyCacheTtlSeconds);
    } catch {
      // A cache write failure does not change the policies just loaded.
    }
  }
  return { version, policies: compiled, loadMs: performance.now() - started };
}

export interface GuardPolicyPlan {
  decision: GuardDecision;
  policies: CompiledGuardPolicy[];
  organisationMode: 'monitor' | 'protect';
  failureMode: 'fail_open' | 'fail_closed' | 'fallback';
  policyLoadMs: number;
}

export async function planGuardPolicies(
  db: AppDatabase,
  input: {
    organisationId: string;
    context: GuardEvaluationContext;
    policyId?: string;
    modelAccessDenied?: boolean;
    enforcementConnected?: boolean;
    cache?: GuardPolicyCacheStore;
  },
): Promise<GuardPolicyPlan> {
  requireOrganisationId(input.organisationId);
  if (input.context.organizationId !== input.organisationId) {
    throw new Error('Policy evaluation organisation does not match the repository scope.');
  }
  return usingTenant(db, input.organisationId, async (tx) => {
    const settings = await tx.select().from(guardSettings).where(eq(guardSettings.organisationId, input.organisationId)).limit(1);
    const organisationMode = settings[0]?.mode === 'protect' ? 'protect' : 'monitor';
    const failureMode = settings[0]?.enforcementFailureMode === 'fail_closed' || settings[0]?.enforcementFailureMode === 'fallback'
      ? settings[0].enforcementFailureMode
      : 'fail_open';
    let policies: CompiledGuardPolicy[];
    let policyLoadMs = 0;
    if (input.policyId) {
      const started = performance.now();
      const detail = await getGuardPolicy(tx, input.organisationId, input.policyId);
      if (!detail) throw new Error('Policy was not found in this organisation.');
      policies = [
        {
          organizationId: input.organisationId,
          policyId: detail.policy.id,
          policyVersionId: detail.policy.versionId,
          name: detail.policy.name,
          version: detail.policy.currentVersion,
          priority: detail.policy.priority,
          mode: detail.policy.mode,
          document: detail.policy.document,
        },
      ];
      policyLoadMs = performance.now() - started;
    } else {
      const loaded = await loadActivePolicies(tx, input.organisationId, input.cache);
      policies = loaded.policies;
      policyLoadMs = loaded.loadMs;
    }
    const decision = evaluatePolicies({
      context: input.context,
      policies,
      organisationMode,
      enforcementConnected: input.enforcementConnected ?? guardLiveEnforcement.connected,
      modelAccessDenied: input.modelAccessDenied,
    });
    return { decision, policies, organisationMode, failureMode, policyLoadMs };
  });
}

export async function persistGuardDecision(
  db: AppDatabase,
  input: {
    organisationId: string;
    context: GuardEvaluationContext;
    source: 'tester' | 'simulation' | 'gateway';
    decision: GuardDecision;
    requestId?: string | null;
    summary?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  requireOrganisationId(input.organisationId);
  await usingTenant(db, input.organisationId, async (tx) => {
    const decision = input.decision;
    const requestedSystemId = input.context.system?.id;
    const knownSystem =
      requestedSystemId && /^[0-9a-f-]{36}$/i.test(requestedSystemId)
        ? (
            await tx
              .select({ id: aiSystems.id })
              .from(aiSystems)
              .where(and(eq(aiSystems.organisationId, input.organisationId), eq(aiSystems.id, requestedSystemId)))
              .limit(1)
          )[0]
        : undefined;
    await tx.insert(guardDecisions).values({
      id: decision.id,
      organisationId: input.organisationId,
      requestId: input.requestId ?? null,
      traceId: input.context.traceId ? sanitizeGuardText(input.context.traceId, 80) : null,
      systemId: knownSystem?.id ?? null,
      decision: decision.decision,
      effectiveMode: decision.effectiveMode,
      wouldEnforceAction: decision.wouldEnforce?.action ?? null,
      wouldEnforcePolicyId: decision.wouldEnforce?.policyId ?? null,
      matchedPolicies: decision.matchedPolicies,
      reasons: decision.reasons,
      contextSummary: { ...summarizeEvaluationContext(input.context), ...(input.summary ?? {}) },
      source: input.source,
      evaluationMs: Math.round(decision.evaluationMs),
      policiesConsidered: decision.policiesConsidered,
      policiesMatched: decision.policiesMatched,
      evaluatedAt: decision.evaluatedAt,
      createdAt: new Date(),
    });
  });
}

export async function evaluateGuardPolicies(
  db: AppDatabase,
  input: {
    organisationId: string;
    context: GuardEvaluationContext;
    source: 'tester' | 'simulation' | 'gateway';
    policyId?: string;
    modelAccessDenied?: boolean;
    enforcementConnected?: boolean;
    cache?: GuardPolicyCacheStore;
  },
): Promise<GuardDecision> {
  const plan = await planGuardPolicies(db, input);
  await persistGuardDecision(db, { ...input, decision: plan.decision });
  return plan.decision;
}

export async function getGuardDecision(db: AppDatabase, organisationId: string, decisionId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const rows = await tx
      .select()
      .from(guardDecisions)
      .where(and(eq(guardDecisions.organisationId, organisationId), eq(guardDecisions.id, decisionId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function listGuardPolicyReferences(db: AppDatabase, organisationId: string) {
  requireOrganisationId(organisationId);
  return usingTenant(db, organisationId, async (tx) => {
    const systems = await tx
      .select({ id: aiSystems.id, name: aiSystems.name })
      .from(aiSystems)
      .where(eq(aiSystems.organisationId, organisationId))
      .orderBy(aiSystems.name);
    const connections = await tx
      .select({ provider: providerConnections.provider })
      .from(providerConnections)
      .where(eq(providerConnections.organisationId, organisationId));
    const models = await tx
      .select({ id: modelCatalogue.id, provider: modelCatalogue.provider, modelName: modelCatalogue.modelName, displayName: modelCatalogue.displayName })
      .from(modelCatalogue)
      .orderBy(modelCatalogue.provider, modelCatalogue.displayName);
    return {
      systems,
      providers: [...new Set(connections.map((connection) => connection.provider))].sort(),
      models,
    };
  });
}
