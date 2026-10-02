export const guardModes = ['monitor', 'protect'] as const;
export type GuardMode = (typeof guardModes)[number];

export const guardStatuses = ['protected', 'monitored', 'unprotected', 'unknown'] as const;
export type GuardStatus = (typeof guardStatuses)[number];

export const guardRuntimes = ['vhalcha_gateway', 'direct', 'external', 'unknown'] as const;
export type GuardRuntime = (typeof guardRuntimes)[number];

export const guardEventTypes = [
  'policy_violation',
  'prompt_injection',
  'sensitive_data',
  'tool_access',
  'permission_escalation',
  'model_violation',
  'blocked_request',
  'redacted_request',
  'runtime_alert',
  'anomalous_activity',
  'system_event',
] as const;
export type GuardEventType = (typeof guardEventTypes)[number];

export const guardThreatEventTypes = [
  'prompt_injection',
  'sensitive_data',
  'tool_access',
  'permission_escalation',
  'model_violation',
  'runtime_alert',
  'anomalous_activity',
] as const satisfies readonly GuardEventType[];

export const guardSeverities = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type GuardSeverity = (typeof guardSeverities)[number];

export const guardActionsTaken = [
  'allow',
  'monitor',
  'warn',
  'redact',
  'block',
  'require_approval',
  'route',
  'log',
] as const;
export type GuardActionTaken = (typeof guardActionsTaken)[number];

export const guardEventStatuses = ['open', 'expected', 'dismissed'] as const;
export type GuardEventStatus = (typeof guardEventStatuses)[number];

export const guardFailureModes = ['fail_open', 'fail_closed', 'fallback'] as const;
export type GuardFailureMode = (typeof guardFailureModes)[number];

export const guardOrganisationLabels = ['standard', 'demo'] as const;
export type GuardOrganisationLabel = (typeof guardOrganisationLabels)[number];

export const guardDataCategories = [
  'pii',
  'financial',
  'secrets',
  'health',
  'confidential',
  'source_code',
  'custom',
] as const;
export type GuardDataCategory = (typeof guardDataCategories)[number];

export const postureStatuses = ['critical', 'weak', 'moderate', 'good', 'strong', 'unscored'] as const;
export type PostureStatus = (typeof postureStatuses)[number];

export interface GuardSettingsSnapshot {
  mode: GuardMode;
  enforcementFailureMode: GuardFailureMode;
  retentionDays: number;
  auditLoggingEnabled: boolean;
  guardEnabled: boolean;
  organisationLabel: GuardOrganisationLabel;
}

export const defaultGuardSettings: GuardSettingsSnapshot = {
  mode: 'monitor',
  enforcementFailureMode: 'fail_open',
  retentionDays: 90,
  auditLoggingEnabled: true,
  guardEnabled: true,
  organisationLabel: 'standard',
};
