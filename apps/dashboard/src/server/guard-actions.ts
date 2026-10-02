'use server';

import { redirect } from 'next/navigation';
import {
  activateGuardPolicy,
  addGuardIncidentNote,
  assignGuardIncident,
  assignGuardThreat,
  attachGuardIncidentEvent,
  attachGuardIncidentThreat,
  createGuardIncident,
  createGuardPolicy,
  deleteGuardPolicy,
  disableGuardPolicy,
  evaluateGuardPolicies,
  markGuardEventExpected,
  updateGuardIncidentStatus,
  updateGuardPolicy,
  updateGuardSettings,
  updateGuardThreatStatus,
  upsertGuardProfile,
} from '@vhalcha/database';
import {
  guardFailureModes,
  guardPolicyCategories,
  guardPolicyModes,
  guardThreatSeverities,
  guardThreatStatuses,
  guardRuntimes,
  guardStatuses,
  sanitizeGuardText,
  type GuardPolicyCategory,
  type GuardPolicyDocument,
  type GuardPolicyMode,
  type GuardRuntime,
  type GuardStatus,
} from '@vhalcha/guard';
import { getServices, requirePermission } from './services';

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
  return allowed.find((item) => item === value) ?? null;
}

export async function saveGuardSettings(formData: FormData) {
  const session = await requirePermission('guard:configure');
  const failure = oneOf(String(formData.get('enforcementFailureMode') ?? ''), guardFailureModes);
  const retention = Number(formData.get('retentionDays'));
  if (!failure || !Number.isInteger(retention)) {
    redirect('/guard/settings?notice=invalid');
  }
  try {
    const requestedMode = String(formData.get('guardMode') ?? '');
    const mode = requestedMode === 'protect' ? 'protect' : requestedMode === 'monitor' ? 'monitor' : undefined;
    if (mode === 'protect' && formData.get('confirmProtect') !== 'yes') {
      redirect('/guard/settings?notice=confirm');
    }
    if (mode === 'protect' && !getServices().config.GUARD_PROTECT_MODE_ENABLED) {
      redirect('/guard/settings?notice=protect-disabled');
    }
    await updateGuardSettings(getServices().db, session.claims.oid, {
      actorUserId: session.claims.uid,
      retentionDays: retention,
      enforcementFailureMode: failure,
      auditLoggingEnabled: formData.get('auditLoggingEnabled') === 'on',
      guardEnabled: formData.get('guardEnabled') === 'on',
      mode,
      protectEnabled: getServices().config.GUARD_PROTECT_MODE_ENABLED,
    });
  } catch {
    redirect('/guard/settings?notice=invalid');
  }
  redirect('/guard/settings?notice=saved');
}

export async function saveGuardProfile(formData: FormData) {
  const session = await requirePermission('guard:configure');
  const aiSystemId = String(formData.get('aiSystemId') ?? '');
  const guardStatus = oneOf(String(formData.get('guardStatus') ?? ''), guardStatuses);
  const runtime = oneOf(String(formData.get('runtime') ?? ''), guardRuntimes);
  if (!guardStatus || !runtime) {
    redirect(`/guard/inventory/${aiSystemId}?notice=invalid`);
  }
  const dataAccess = String(formData.get('dataAccess') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  try {
    await upsertGuardProfile(getServices().db, session.claims.oid, {
      aiSystemId,
      actorUserId: session.claims.uid,
      guardStatus: guardStatus as GuardStatus,
      runtime: runtime as GuardRuntime,
      dataAccess,
      sensitiveDataUnrestricted: formData.get('sensitiveDataUnrestricted') === 'on',
      overprivileged: formData.get('overprivileged') === 'on',
    });
  } catch {
    redirect(`/guard/inventory/${aiSystemId}?notice=invalid`);
  }
  redirect(`/guard/inventory/${aiSystemId}?notice=saved`);
}

export async function markExpectedGuardEvent(formData: FormData) {
  const session = await requirePermission('guard:configure');
  const eventId = String(formData.get('eventId') ?? '');
  const returnTo = String(formData.get('returnTo') ?? '/guard');
  const safeReturn = returnTo.startsWith('/guard') ? returnTo : '/guard';
  const updated = await markGuardEventExpected(getServices().db, session.claims.oid, eventId, session.claims.uid);
  const joiner = safeReturn.includes('?') ? '&' : '?';
  redirect(`${safeReturn}${joiner}event=${encodeURIComponent(eventId)}&notice=${updated ? 'expected' : 'missing'}`);
}

function rethrowRedirect(error: unknown): void {
  if (typeof error === 'object' && error !== null && 'digest' in error && String((error as { digest?: string }).digest).startsWith('NEXT_REDIRECT')) {
    throw error;
  }
}

function safeNotice(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/unique|duplicate/i.test(message)) return 'A policy with that name already exists.';
  if (/failed query|syntax error|\bselect\b|\binsert\b/i.test(message)) return 'The policy could not be saved.';
  return (message || 'The policy could not be saved.').slice(0, 180);
}

function readPolicyPayload(formData: FormData) {
  const raw = String(formData.get('payload') ?? '');
  const body = JSON.parse(raw) as {
    name?: string;
    description?: string;
    category?: string;
    priority?: number;
    mode?: string;
    document?: GuardPolicyDocument;
  };
  const category = guardPolicyCategories.find((item) => item === body.category);
  const mode = guardPolicyModes.find((item) => item === body.mode);
  if (!category || !mode || !body.document || !body.name) {
    throw new Error('Policy details are incomplete.');
  }
  return {
    name: body.name,
    description: body.description,
    category: category as GuardPolicyCategory,
    mode: mode as GuardPolicyMode,
    priority: Number(body.priority),
    document: body.document,
  };
}

export async function saveGuardPolicy(formData: FormData) {
  const policyId = String(formData.get('policyId') ?? '');
  const session = await requirePermission(policyId ? 'guard:policy:edit' : 'guard:policy:create');
  let savedId = policyId;
  try {
    const payload = readPolicyPayload(formData);
    if (policyId) {
      const updated = await updateGuardPolicy(getServices().db, {
        organisationId: session.claims.oid,
        actorUserId: session.claims.uid,
        policyId,
        ...payload,
      });
      savedId = updated.policyId;
    } else {
      const created = await createGuardPolicy(getServices().db, {
        organisationId: session.claims.oid,
        actorUserId: session.claims.uid,
        ...payload,
      });
      savedId = created.policyId;
    }
  } catch (error) {
    rethrowRedirect(error);
    const target = policyId ? `/guard/policies/${policyId}/edit` : '/guard/policies/new';
    redirect(`${target}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/policies/${savedId}?notice=saved`);
}

export async function activateGuardPolicyAction(formData: FormData) {
  const session = await requirePermission('guard:policy:activate');
  const policyId = String(formData.get('policyId') ?? '');
  try {
    await activateGuardPolicy(getServices().db, session.claims.oid, policyId, session.claims.uid);
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/policies/${policyId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/policies/${policyId}?notice=activated`);
}

export async function disableGuardPolicyAction(formData: FormData) {
  const session = await requirePermission('guard:policy:activate');
  const policyId = String(formData.get('policyId') ?? '');
  try {
    await disableGuardPolicy(getServices().db, session.claims.oid, policyId, session.claims.uid);
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/policies/${policyId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/policies/${policyId}?notice=disabled`);
}

export async function deleteGuardPolicyAction(formData: FormData) {
  const session = await requirePermission('guard:policy:edit');
  const policyId = String(formData.get('policyId') ?? '');
  try {
    await deleteGuardPolicy(getServices().db, session.claims.oid, policyId, session.claims.uid);
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/policies/${policyId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect('/guard/policies?notice=deleted');
}

export async function testGuardPolicy(formData: FormData) {
  const session = await requirePermission('guard:policy:edit');
  const policyId = String(formData.get('policyId') ?? '');
  const evaluationSet = String(formData.get('evaluationSet') ?? 'all');
  const tokens = (name: string) =>
    String(formData.get(name) ?? '')
      .split(',')
      .map((item) => sanitizeGuardText(item.trim(), 64))
      .filter((item) => item.length > 0 && item.toLowerCase() !== 'none');
  try {
    const decision = await evaluateGuardPolicies(getServices().db, {
      organisationId: session.claims.oid,
      source: 'tester',
      policyId: evaluationSet === 'policy' && policyId ? policyId : undefined,
      context: {
        organizationId: session.claims.oid,
        system: formData.get('systemId') ? { id: String(formData.get('systemId')) } : undefined,
        environment: String(formData.get('environment') ?? ''),
        provider: { id: sanitizeGuardText(String(formData.get('providerId') ?? ''), 80) },
        model: formData.get('modelId') ? { id: String(formData.get('modelId')) } : undefined,
        request: {
          detectedDataTypes: tokens('detectedData'),
          promptRiskFlags: tokens('promptRiskFlags'),
        },
        tool: {
          name: sanitizeGuardText(String(formData.get('toolName') ?? ''), 80) || undefined,
          riskLevel: sanitizeGuardText(String(formData.get('toolRisk') ?? ''), 40) || undefined,
        },
      },
    });
    redirect(`/guard/policies/decisions/${decision.id}`);
  } catch (error) {
    rethrowRedirect(error);
    const target = policyId ? `/guard/policies/${policyId}/test` : '/guard/policies';
    redirect(`${target}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
}

function guardReturn(formData: FormData, fallback: string) {
  const value = String(formData.get('returnTo') ?? fallback);
  return value.startsWith('/guard') ? value : fallback;
}

export async function createGuardIncidentAction(formData: FormData) {
  const session = await requirePermission('guard:incident:manage');
  const severity = oneOf(String(formData.get('severity') ?? 'medium'), guardThreatSeverities) ?? 'medium';
  try {
    const id = await createGuardIncident(getServices().db, session.claims.oid, {
      actorUserId: session.claims.uid,
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
      severity,
      threatId: String(formData.get('threatId') ?? '') || null,
      eventId: String(formData.get('eventId') ?? '') || null,
    });
    redirect(`/guard/incidents/${id}`);
  } catch (error) {
    rethrowRedirect(error);
    redirect(`${guardReturn(formData, '/guard/incidents')}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
}

export async function updateGuardThreatAction(formData: FormData) {
  const session = await requirePermission('guard:incident:manage');
  const threatId = String(formData.get('threatId') ?? '');
  const status = oneOf(String(formData.get('status') ?? ''), guardThreatStatuses);
  try {
    if (!status) throw new Error('Unknown threat status.');
    await updateGuardThreatStatus(getServices().db, session.claims.oid, {
      threatId,
      actorUserId: session.claims.uid,
      status,
      reason: String(formData.get('reason') ?? ''),
    });
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/threats/${threatId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/threats/${threatId}?notice=saved`);
}

export async function assignGuardThreatAction(formData: FormData) {
  const session = await requirePermission('guard:incident:manage');
  const threatId = String(formData.get('threatId') ?? '');
  const assignee = String(formData.get('assigneeUserId') ?? '');
  try {
    await assignGuardThreat(getServices().db, session.claims.oid, {
      threatId,
      actorUserId: session.claims.uid,
      assigneeUserId: assignee || null,
    });
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/threats/${threatId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/threats/${threatId}?notice=saved`);
}

export async function assignGuardIncidentAction(formData: FormData) {
  const session = await requirePermission('guard:incident:manage');
  const incidentId = String(formData.get('incidentId') ?? '');
  const assignee = String(formData.get('assigneeUserId') ?? '');
  try {
    await assignGuardIncident(getServices().db, session.claims.oid, {
      incidentId,
      actorUserId: session.claims.uid,
      assigneeUserId: assignee || null,
    });
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/incidents/${incidentId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/incidents/${incidentId}?notice=saved`);
}

export async function addGuardIncidentNoteAction(formData: FormData) {
  const session = await requirePermission('guard:incident:manage');
  const incidentId = String(formData.get('incidentId') ?? '');
  try {
    await addGuardIncidentNote(getServices().db, session.claims.oid, {
      incidentId,
      actorUserId: session.claims.uid,
      body: String(formData.get('body') ?? ''),
    });
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/incidents/${incidentId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/incidents/${incidentId}?notice=saved`);
}

export async function updateGuardIncidentAction(formData: FormData) {
  const session = await requirePermission('guard:incident:manage');
  const incidentId = String(formData.get('incidentId') ?? '');
  try {
    await updateGuardIncidentStatus(getServices().db, session.claims.oid, {
      incidentId,
      actorUserId: session.claims.uid,
      status: String(formData.get('status') ?? ''),
      resolution: String(formData.get('resolution') ?? ''),
      followUp: String(formData.get('followUp') ?? ''),
    });
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/incidents/${incidentId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/incidents/${incidentId}?notice=saved`);
}

export async function attachGuardIncidentAction(formData: FormData) {
  const session = await requirePermission('guard:incident:manage');
  const incidentId = String(formData.get('incidentId') ?? '');
  const threatId = String(formData.get('threatId') ?? '');
  const eventId = String(formData.get('eventId') ?? '');
  try {
    if (threatId) {
      await attachGuardIncidentThreat(getServices().db, session.claims.oid, {
        incidentId,
        threatId,
        actorUserId: session.claims.uid,
      });
    }
    if (eventId) {
      await attachGuardIncidentEvent(getServices().db, session.claims.oid, {
        incidentId,
        eventId,
        actorUserId: session.claims.uid,
      });
    }
  } catch (error) {
    rethrowRedirect(error);
    redirect(`/guard/incidents/${incidentId}?notice=${encodeURIComponent(safeNotice(error))}`);
  }
  redirect(`/guard/incidents/${incidentId}?notice=saved`);
}
