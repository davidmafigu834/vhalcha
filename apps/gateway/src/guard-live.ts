import { createRepositories, getGuardSettings, persistGuardDecision, planGuardPolicies, recordGuardEvent } from '@vhalcha/database';
import {
  applyGuardEnforcement,
  inspectGuardRequest,
  inspectGuardResponse,
  primaryAction,
  type GuardEnforcementResult,
  type GuardFinding,
  type GuardInspectionResult,
} from '@vhalcha/guard';
import { GatewayError, type ChatCompletionRequest } from '@vhalcha/types';
import type { GatewayDeps, PreparedChat } from './pipeline';

export interface LiveGuardState {
  inspection?: GuardInspectionResult;
  inspectionMs: number;
  policyLoadMs: number;
  evaluationMs: number;
  enforcementMs: number;
  totalMs: number;
  outcome: GuardEnforcementResult['outcome'] | 'skipped' | 'failed_open';
  decisionId?: string;
  policiesConsidered: number;
  policiesMatched: number;
  providerInvoked: boolean;
  redactionSummary?: Record<string, number>;
  enforcementExecuted: boolean;
  requestedAction?: string;
  policyName?: string;
  policyId?: string;
  policyVersion?: number;
  responseInspection: 'not_run' | 'passthrough' | 'skipped_stream';
  eventsWritten?: boolean;
  environment?: string;
  systemType?: string;
  systemRisk?: string;
}

function guardActive(deps: GatewayDeps) {
  return deps.guardEnabled !== false;
}

function logGuard(deps: GatewayDeps, prepared: PreparedChat, state: LiveGuardState) {
  deps.logger.info(
    {
      request_id: prepared.requestId,
      organisation_id: prepared.organisationId,
      ai_system_id: prepared.aiSystemId,
      guard_inspection_ms: Math.round(state.inspectionMs),
      guard_policy_load_ms: Math.round(state.policyLoadMs),
      guard_policy_eval_ms: Math.round(state.evaluationMs),
      guard_enforcement_ms: Math.round(state.enforcementMs),
      guard_total_ms: Math.round(state.totalMs),
      guard_outcome: state.outcome,
      guard_policies_considered: state.policiesConsidered,
      guard_policies_matched: state.policiesMatched,
      provider_invoked: state.providerInvoked,
    },
    'guard request',
  );
}

async function loadIdentity(deps: GatewayDeps, prepared: PreparedChat) {
  const repos = createRepositories(deps.db);
  const [system, environment] = await Promise.all([
    repos.aiSystems.findById(prepared.organisationId, prepared.aiSystemId),
    repos.environments.findById(prepared.organisationId, prepared.environmentId),
  ]);
  return { system, environment };
}

export async function inspectLiveGuard(deps: GatewayDeps, prepared: PreparedChat): Promise<void> {
  if (!guardActive(deps)) return;
  const settings = await getGuardSettings(deps.db, prepared.organisationId);
  if (!settings.guardEnabled) return;
  const started = performance.now();
  const state: LiveGuardState = {
    inspectionMs: 0,
    policyLoadMs: 0,
    evaluationMs: 0,
    enforcementMs: 0,
    totalMs: 0,
    outcome: 'continued',
    policiesConsidered: 0,
    policiesMatched: 0,
    providerInvoked: true,
    enforcementExecuted: false,
    responseInspection: 'not_run',
  };
  try {
    const identity = await loadIdentity(deps, prepared);
    state.environment = identity.environment?.type;
    state.systemType = identity.system?.type;
    state.systemRisk = identity.system?.riskLevel;
    state.inspection = inspectGuardRequest({ messages: prepared.body.messages });
    state.inspectionMs = performance.now() - started;
  } catch (error) {
    state.inspectionMs = performance.now() - started;
    state.outcome = settings.enforcementFailureMode === 'fail_closed' ? 'failed_closed' : 'failed_open';
    prepared.guard = state;
    logGuard(deps, prepared, state);
    if (settings.enforcementFailureMode === 'fail_closed') {
      throw new GatewayError(
        'guard_enforcement_unavailable',
        'Guard could not inspect this request.',
        {},
        prepared.requestId,
      );
    }
    deps.logger.error({ request_id: prepared.requestId, name: error instanceof Error ? error.name : 'Error' }, 'guard inspection failed open');
    return;
  }
  prepared.guard = state;
}

export async function enforceLiveGuard(deps: GatewayDeps, prepared: PreparedChat): Promise<void> {
  const state = prepared.guard;
  if (!state || state.outcome === 'failed_open' || state.outcome === 'failed_closed') return;
  const started = performance.now();
  const settings = await getGuardSettings(deps.db, prepared.organisationId);
  const selected = prepared.routing?.ranked[prepared.routing.attempt]?.model;
  const inspection = state.inspection ?? { findings: [], detectedDataTypes: [], detectedSecrets: [], promptRiskFlags: [] };
  try {
    const plan = await planGuardPolicies(deps.db, {
      organisationId: prepared.organisationId,
      enforcementConnected: deps.protectModeEnabled === true && settings.mode === 'protect',
      cache: deps.redis,
      context: {
        organizationId: prepared.organisationId,
        requestId: prepared.requestId,
        traceId: prepared.requestId,
        system: { id: prepared.aiSystemId, type: state.systemType, riskLevel: state.systemRisk },
        environment: state.environment,
        provider: { id: prepared.provider, name: prepared.provider },
        model: { id: selected?.id ?? prepared.body.model, name: selected?.modelName ?? prepared.body.model },
        actor: { serviceId: prepared.virtualApiKeyId },
        request: {
          detectedDataTypes: inspection.detectedDataTypes,
          detectedSecrets: inspection.detectedSecrets,
          promptRiskFlags: inspection.promptRiskFlags,
          detectedDataCount: inspection.findings.reduce((total, finding) => total + finding.count, 0),
        },
        runtime: { type: 'vhalcha_gateway' },
      },
    });
    state.policyLoadMs = plan.policyLoadMs;
    state.evaluationMs = plan.decision.evaluationMs;
    state.policiesConsidered = plan.decision.policiesConsidered;
    state.policiesMatched = plan.decision.policiesMatched;
    state.decisionId = plan.decision.id;
    const winner = plan.policies.find((policy) => policy.policyId === (plan.decision.wouldEnforce?.policyId ?? plan.decision.matchedPolicies[0]?.policyId));
    const action = winner ? primaryAction(winner.document.actions) : undefined;
    state.policyName = winner?.name;
    state.policyId = winner?.policyId;
    state.policyVersion = winner?.version;
    const enforceStarted = performance.now();
    const enforced = applyGuardEnforcement({
      decision: plan.decision,
      messages: prepared.body.messages,
      findings: inspection.findings,
      dataTypes: action?.type === 'redact' ? action.config?.dataTypes : undefined,
      failureMode: plan.failureMode,
    });
    state.enforcementMs = performance.now() - enforceStarted;
    state.outcome = enforced.outcome;
    state.enforcementExecuted = enforced.enforcementExecuted;
    state.requestedAction = enforced.requestedAction;
    state.redactionSummary = enforced.redactionSummary;
    state.providerInvoked = enforced.outcome !== 'blocked' && enforced.outcome !== 'failed_closed';
    if (enforced.outcome === 'redacted') {
      prepared.body = {
        ...prepared.body,
        messages: enforced.messages.map((message, index) => ({
          role: prepared.body.messages[index]?.role ?? 'user',
          content: typeof message.content === 'string' ? message.content : prepared.body.messages[index]?.content ?? '',
        })),
      } as ChatCompletionRequest;
    }
    const summary = {
      outcome: enforced.outcome,
      enforcementExecuted: enforced.enforcementExecuted ? 'true' : 'false',
      redactionSummary: Object.entries(enforced.redactionSummary ?? {})
        .map(([key, count]) => `${key}=${count}`)
        .join(','),
      guard_total_ms: Math.round(performance.now() - started + state.inspectionMs),
    };
    try {
      await persistGuardDecision(deps.db, {
        organisationId: prepared.organisationId,
        context: {
          organizationId: prepared.organisationId,
          requestId: prepared.requestId,
          traceId: prepared.requestId,
          system: { id: prepared.aiSystemId },
          provider: { id: prepared.provider },
          model: { id: selected?.id ?? prepared.body.model, name: prepared.body.model },
          request: {
            detectedDataTypes: inspection.detectedDataTypes,
            detectedSecrets: inspection.detectedSecrets,
          },
        },
        source: 'gateway',
        decision: plan.decision,
        summary,
      });
    } catch (error) {
      deps.logger.error({ request_id: prepared.requestId, name: error instanceof Error ? error.name : 'Error' }, 'guard decision persistence failed');
      if (enforced.outcome === 'blocked' || enforced.outcome === 'failed_closed') {
        state.totalMs = performance.now() - started + state.inspectionMs;
        logGuard(deps, prepared, state);
        await writeBlockedRequest(deps, prepared, state).catch(() => undefined);
        throw guardStop(prepared, state, enforced.outcome === 'blocked' ? 'guard_policy_blocked' : 'guard_enforcement_unavailable');
      }
    }
    state.totalMs = state.inspectionMs + state.policyLoadMs + state.evaluationMs + state.enforcementMs;
    logGuard(deps, prepared, state);
    if (enforced.outcome === 'blocked' || enforced.outcome === 'failed_closed') {
      await writeBlockedRequest(deps, prepared, state);
      throw guardStop(prepared, state, enforced.outcome === 'blocked' ? 'guard_policy_blocked' : 'guard_enforcement_unavailable');
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    const closed = settings.enforcementFailureMode === 'fail_closed';
    state.outcome = closed ? 'failed_closed' : 'failed_open';
    state.providerInvoked = !closed;
    state.totalMs = performance.now() - started + state.inspectionMs;
    logGuard(deps, prepared, state);
    deps.logger.error({ request_id: prepared.requestId, name: error instanceof Error ? error.name : 'Error' }, 'guard evaluation failed');
    if (closed) {
      throw new GatewayError('guard_enforcement_unavailable', 'Guard could not evaluate this request.', {}, prepared.requestId);
    }
  }
}

function guardStop(prepared: PreparedChat, state: LiveGuardState, code: 'guard_policy_blocked' | 'guard_enforcement_unavailable') {
  const message =
    code === 'guard_policy_blocked'
      ? `Blocked by policy ${state.policyName ?? 'Guard policy'}.`
      : 'Guard could not apply the required enforcement action.';
  return new GatewayError(code, message, {}, prepared.requestId, undefined, {
    ...(state.decisionId ? { decision_id: state.decisionId } : {}),
    ...(state.policyName ? { policy: state.policyName } : {}),
  });
}

async function writeBlockedRequest(deps: GatewayDeps, prepared: PreparedChat, state: LiveGuardState) {
  const repos = createRepositories(deps.db);
  await repos.requests.create({
    id: prepared.requestId,
    organisationId: prepared.organisationId,
    aiSystemId: prepared.aiSystemId,
    environmentId: prepared.environmentId,
    virtualApiKeyId: prepared.virtualApiKeyId,
    provider: prepared.provider,
    model: prepared.body.model,
    status: 'blocked',
    policyResult: 'blocked',
    startedAt: prepared.startedAt,
    completedAt: new Date(),
    httpStatus: 403,
    errorCode: state.outcome === 'blocked' ? 'guard_policy_blocked' : 'guard_enforcement_unavailable',
    errorMessageSafe: 'The request was stopped by Guard before it reached a provider.',
  });
  await writeGuardEvents(deps, prepared);
}

export async function writeGuardEvents(deps: GatewayDeps, prepared: PreparedChat) {
  const state = prepared.guard;
  if (!state || state.eventsWritten || !state.inspection) return;
  const findings = state.inspection.findings;
  const classification = [...new Set(findings.map((finding: GuardFinding) => finding.classification))].join(',');
  const matchCount = findings.reduce((total, finding) => total + finding.count, 0);
  const evidence = {
    outcome: state.outcome,
    classification,
    matchCount,
    redactionSummary: Object.entries(state.redactionSummary ?? {})
      .map(([key, count]) => `${key}=${count}`)
      .join(','),
    enforcementExecuted: state.enforcementExecuted ? 'true' : 'false',
  };
  const common = {
    organisationId: prepared.organisationId,
    aiSystemId: prepared.aiSystemId,
    environmentId: prepared.environmentId,
    provider: prepared.provider,
    model: prepared.body.model,
    runtime: 'vhalcha_gateway',
    policyName: state.policyName,
    policyId: state.policyId,
    policyVersion: state.policyVersion,
    requestId: prepared.requestId,
    traceId: prepared.requestId,
    decisionId: state.decisionId,
    evidence,
  };
  await recordGuardEvent(deps.db, {
    ...common,
    eventType: 'system_event',
    severity: 'info',
    title: 'Request inspected',
    description: 'Guard inspected this live gateway request.',
    actionTaken: 'monitor',
  });
  if (findings.some((finding) => finding.kind === 'sensitive_data' || finding.kind === 'secret')) {
    await recordGuardEvent(deps.db, {
      ...common,
      eventType: 'sensitive_data',
      severity: 'medium',
      title: 'Sensitive data detected',
      description: classification || 'A conservative detector matched.',
      actionTaken: state.enforcementExecuted && state.outcome === 'redacted' ? 'redact' : 'monitor',
      dataCategory: findings.some((finding) => finding.kind === 'secret') ? 'secrets' : 'pii',
    });
  }
  if (state.outcome === 'would_enforce' || state.outcome === 'blocked' || state.outcome === 'redacted' || state.requestedAction === 'warn') {
    await recordGuardEvent(deps.db, {
      ...common,
      eventType: 'policy_violation',
      severity: 'medium',
      title: state.policyName ? `${state.policyName} matched` : 'Guard policy matched',
      description: state.enforcementExecuted ? 'The supported action was applied.' : 'The match was recorded without changing the request.',
      actionTaken: 'monitor',
    });
  }
  if (state.outcome === 'blocked') {
    await recordGuardEvent(deps.db, {
      ...common,
      eventType: 'blocked_request',
      severity: 'high',
      title: state.policyName ? `Request blocked by ${state.policyName}` : 'Request blocked by Guard',
      actionTaken: 'block',
    });
  }
  if (state.outcome === 'redacted') {
    await recordGuardEvent(deps.db, {
      ...common,
      eventType: 'redacted_request',
      severity: 'medium',
      title: state.policyName ? `${state.policyName} redacted request content` : 'Request content redacted',
      description: evidence.redactionSummary || 'Values were replaced before the provider call.',
      actionTaken: 'redact',
    });
  }
  if (state.outcome === 'failed_open' || state.outcome === 'failed_closed') {
    await recordGuardEvent(deps.db, {
      ...common,
      eventType: 'runtime_alert',
      severity: 'high',
      title: state.outcome === 'failed_closed' ? 'Enforcement unavailable, request stopped' : 'Enforcement unavailable, request continued',
      actionTaken: state.outcome === 'failed_closed' ? 'block' : 'monitor',
      evidence: { ...evidence, errorCode: state.outcome },
    });
  }
  state.eventsWritten = true;
}

export function noteGuardResponse(deps: GatewayDeps, prepared: PreparedChat, streamed: boolean, responseText?: string) {
  const state = prepared.guard;
  if (!state) return;
  if (streamed) {
    state.responseInspection = 'skipped_stream';
    return;
  }
  const inspected = inspectGuardResponse(responseText);
  state.responseInspection = inspected.applied ? 'passthrough' : 'passthrough';
  deps.logger.info(
    { request_id: prepared.requestId, response_inspection: 'passthrough', response_findings: inspected.findings.length },
    'guard response inspection',
  );
}
