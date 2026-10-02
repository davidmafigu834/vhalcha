import type { GuardFailureMode } from './types';
import { markersForDataTypes, redactGuardValue, type GuardFinding, type GuardRedactionMarker } from './inspect';
import type { GuardDecision, GuardPolicyActionType } from './policy';

export type GuardEnforcementOutcome =
  | 'continued'
  | 'blocked'
  | 'redacted'
  | 'would_enforce'
  | 'failed_open'
  | 'failed_closed'
  | 'unsupported';

export interface GuardEnforcementResult {
  decisionId: string;
  requestedAction: GuardPolicyActionType | GuardDecision['decision'];
  executedAction?: 'block' | 'redact';
  enforcementExecuted: boolean;
  outcome: GuardEnforcementOutcome;
  redactionSummary?: Record<string, number>;
  errorCode?: string;
  messages: Array<{ role: string; content: unknown }>;
}

const supportedLiveActions = new Set(['allow', 'monitor', 'warn', 'log', 'block', 'redact']);

function addCounts(target: Record<string, number>, extra: Record<string, number>) {
  for (const [key, count] of Object.entries(extra)) target[key] = (target[key] ?? 0) + count;
}

export function applyGuardEnforcement(input: {
  decision: GuardDecision;
  messages: Array<{ role: string; content: unknown }>;
  findings: GuardFinding[];
  dataTypes?: string[];
  failureMode: GuardFailureMode;
}): GuardEnforcementResult {
  const requested = input.decision.wouldEnforce?.action ?? input.decision.decision;
  const base = {
    decisionId: input.decision.id,
    requestedAction: requested,
    messages: input.messages,
  };
  const heldBack = input.decision.effectiveMode !== 'enforce' || Boolean(input.decision.wouldEnforce && input.decision.decision === 'monitor');
  if (heldBack) {
    return {
      ...base,
      enforcementExecuted: false,
      outcome: input.decision.wouldEnforce ? 'would_enforce' : 'continued',
    };
  }
  if (!supportedLiveActions.has(requested)) {
    const closed = input.failureMode === 'fail_closed';
    return {
      ...base,
      enforcementExecuted: false,
      outcome: closed ? 'failed_closed' : 'failed_open',
      errorCode: closed ? 'enforcement_unavailable_fail_closed' : 'enforcement_unavailable',
    };
  }
  if (requested === 'block') {
    return { ...base, executedAction: 'block', enforcementExecuted: true, outcome: 'blocked' };
  }
  if (requested === 'redact') {
    const allowed: ReadonlySet<GuardRedactionMarker> = markersForDataTypes(input.dataTypes, input.findings);
    const summary: Record<string, number> = {};
    const messages = input.messages.map((message) => {
      const redacted = redactGuardValue(message.content, allowed);
      addCounts(summary, redacted.counts);
      return { ...message, content: redacted.value };
    });
    return {
      ...base,
      messages,
      executedAction: 'redact',
      enforcementExecuted: true,
      outcome: 'redacted',
      redactionSummary: summary,
    };
  }
  return { ...base, enforcementExecuted: false, outcome: 'continued' };
}
