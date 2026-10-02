/**
 * Severity rules, applied in order. The highest matching rank wins.
 *
 * - Email or phone customer PII: medium.
 * - Luhn-valid payment card: high.
 * - Private key, API key, access token, or other authentication secret: high.
 * - Protect-mode fail-closed enforcement failure: high.
 * - The same fail-closed fingerprint reaching 5 occurrences: critical.
 * - A blocked policy match without sensitive data: high.
 * - An observed policy match: medium.
 * - Anything else that is still threat-worthy: low.
 *
 * Critical is not a default. Prompt risk and suspicious tool actions are not
 * produced until a real inspector emits them.
 */
export const guardThreatTypes = [
  'sensitive_data_exposure',
  'secret_exposure',
  'policy_violation',
  'unapproved_provider',
  'unapproved_model',
  'runtime_enforcement_failure',
  'suspicious_tool_action',
  'prompt_risk',
  'other',
] as const;
export type GuardThreatType = (typeof guardThreatTypes)[number];

export const guardThreatStatuses = ['open', 'investigating', 'contained', 'resolved', 'dismissed', 'expected'] as const;
export type GuardThreatStatus = (typeof guardThreatStatuses)[number];

export const guardThreatSeverities = ['low', 'medium', 'high', 'critical'] as const;
export type GuardThreatSeverity = (typeof guardThreatSeverities)[number];

export const GUARD_THREAT_GROUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GUARD_FAIL_CLOSED_CRITICAL_COUNT = 5;

const threatEventTypes = new Set(['sensitive_data', 'policy_violation', 'blocked_request', 'redacted_request', 'runtime_alert']);
const secretClassifications = new Set(['PRIVATE_KEY', 'API_KEY', 'ACCESS_TOKEN', 'AUTHENTICATION_SECRET']);
const severityRank: Record<GuardThreatSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export const guardThreatTypeLabels: Record<GuardThreatType, string> = {
  sensitive_data_exposure: 'Sensitive data exposure',
  secret_exposure: 'Secret exposure',
  policy_violation: 'Policy violation',
  unapproved_provider: 'Unapproved provider',
  unapproved_model: 'Unapproved model',
  runtime_enforcement_failure: 'Runtime enforcement failure',
  suspicious_tool_action: 'Suspicious tool action',
  prompt_risk: 'Prompt risk',
  other: 'Other',
};

const classificationLabels: Record<string, string> = {
  CUSTOMER_PII: 'Customer PII',
  PAYMENT_CARD: 'Payment card',
  PRIVATE_KEY: 'Private key',
  API_KEY: 'API key',
  ACCESS_TOKEN: 'Access token',
  AUTHENTICATION_SECRET: 'Authentication secret',
  EMAIL: 'Email',
  PHONE: 'Phone',
  SECRET: 'Secret',
};

export function guardClassificationLabel(value: string): string {
  return classificationLabels[value] ?? value.replaceAll('_', ' ');
}

export function formatGuardSequence(prefix: 'THR' | 'INC', value: number): string {
  return `${prefix}-${String(value).padStart(6, '0')}`;
}

export function classificationsFromEvidence(evidence: Record<string, unknown>): string[] {
  const raw = typeof evidence.classification === 'string' ? evidence.classification : '';
  return [...new Set(raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0))].sort();
}

export function redactionCounts(summary: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const part of summary.split(',')) {
    const [marker, count] = part.split('=');
    const value = Number(count);
    if (marker && Number.isInteger(value) && value > 0) counts[marker.trim()] = value;
  }
  return counts;
}

export function guardThreatFingerprint(input: {
  organizationId: string;
  systemId?: string | null;
  type: GuardThreatType;
  policyId?: string | null;
  classification: string;
  provider?: string | null;
  model?: string | null;
}): string {
  return [
    input.organizationId,
    input.systemId ?? '',
    input.type,
    input.policyId ?? '',
    input.classification,
    input.provider ?? '',
    input.model ?? '',
  ].join('\n');
}

export function higherThreatSeverity(left: GuardThreatSeverity, right: GuardThreatSeverity): GuardThreatSeverity {
  return severityRank[left] >= severityRank[right] ? left : right;
}

export interface GuardThreatClassificationInput {
  eventType: string;
  dataCategory?: string | null;
  evidence?: Record<string, unknown>;
  failClosedCount?: number;
}

export interface GuardThreatClassification {
  type: GuardThreatType;
  severity: GuardThreatSeverity;
  classifications: string[];
  outcome: string;
  redactionSummary: string;
  title: string;
}

export function classifyGuardThreat(input: GuardThreatClassificationInput): GuardThreatClassification | null {
  if (!threatEventTypes.has(input.eventType)) return null;
  const evidence = input.evidence ?? {};
  const classifications = classificationsFromEvidence(evidence);
  const outcome = typeof evidence.outcome === 'string' ? evidence.outcome : '';
  const redactionSummary = typeof evidence.redactionSummary === 'string' ? evidence.redactionSummary : '';
  const secret = classifications.some((item) => secretClassifications.has(item)) || input.dataCategory === 'secrets';
  const card = classifications.includes('PAYMENT_CARD');
  const pii = classifications.includes('CUSTOMER_PII') || input.dataCategory === 'pii' || input.dataCategory === 'financial';
  let type: GuardThreatType = 'policy_violation';
  if (input.eventType === 'runtime_alert') type = 'runtime_enforcement_failure';
  else if (secret) type = 'secret_exposure';
  else if (card || pii || input.eventType === 'sensitive_data') type = 'sensitive_data_exposure';
  const failClosed = outcome === 'failed_closed' || evidence.errorCode === 'failed_closed';
  const failClosedCount = input.failClosedCount ?? (failClosed ? 1 : 0);
  let severity: GuardThreatSeverity = 'low';
  if (type === 'runtime_enforcement_failure' && failClosed && failClosedCount >= GUARD_FAIL_CLOSED_CRITICAL_COUNT) severity = 'critical';
  else if (type === 'runtime_enforcement_failure' && failClosed) severity = 'high';
  else if (type === 'runtime_enforcement_failure') severity = 'medium';
  else if (secret || card) severity = 'high';
  else if (pii) severity = 'medium';
  else if (outcome === 'blocked' || input.eventType === 'blocked_request') severity = 'high';
  else if (input.eventType === 'policy_violation' || input.eventType === 'redacted_request') severity = 'medium';
  return {
    type,
    severity,
    classifications,
    outcome,
    redactionSummary,
    title: guardThreatTypeLabels[type],
  };
}

export function explainGuardThreat(input: {
  type: GuardThreatType;
  systemName?: string | null;
  policyName?: string | null;
  policyVersion?: number | null;
  classifications: string[];
  outcome: string;
  redactionSummary?: string | null;
  enforcementExecuted?: boolean;
}): { happened: string; action: string } {
  const system = input.systemName || 'an AI system';
  const policy = input.policyName
    ? `${input.policyName}${input.policyVersion ? ` v${input.policyVersion}` : ''}`
    : 'A Guard policy';
  const found = input.classifications.map(guardClassificationLabel);
  const subject =
    input.type === 'secret_exposure'
      ? 'a secret'
      : input.type === 'sensitive_data_exposure'
        ? found.length > 0
          ? found.join(', ')
          : 'sensitive data'
        : input.type === 'runtime_enforcement_failure'
          ? 'an enforcement failure'
          : 'a policy match';
  const happened = `Guard detected ${subject} in a request from ${system}. ${policy} matched.`;
  if (input.outcome === 'blocked') {
    return { happened, action: 'BLOCKED. The provider was not invoked.' };
  }
  if (input.outcome === 'redacted') {
    const counts = redactionCounts(input.redactionSummary ?? '');
    const detail = Object.entries(counts)
      .map(([marker, count]) => `${count} ${guardClassificationLabel(marker).toLowerCase()}`)
      .join(', ');
    return {
      happened,
      action: detail
        ? `REDACTED. ${detail} replaced before the request was sent to the provider.`
        : 'REDACTED. Detected values were replaced before the request was sent to the provider.',
    };
  }
  if (input.outcome === 'failed_closed') {
    return { happened, action: 'STOPPED. The required enforcement action is not available and this organisation fails closed.' };
  }
  if (input.outcome === 'failed_open') {
    return { happened, action: 'CONTINUED. The required enforcement action is not available and this organisation fails open.' };
  }
  if (input.outcome === 'would_enforce' || input.enforcementExecuted === false) {
    return { happened, action: 'OBSERVED. Guard did not modify the request.' };
  }
  return { happened, action: 'RECORDED. Guard stored the event without changing the request.' };
}

export function withinThreatWindow(lastSeenAt: Date, occurredAt: Date, windowMs = GUARD_THREAT_GROUP_WINDOW_MS): boolean {
  return Math.abs(occurredAt.getTime() - lastSeenAt.getTime()) <= windowMs;
}
