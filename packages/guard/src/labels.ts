import type { GuardActionTaken, GuardEventType, GuardRuntime, GuardStatus } from './types';

export const guardEventTypeLabels: Record<GuardEventType, string> = {
  policy_violation: 'Policy violation',
  prompt_injection: 'Prompt injection detected',
  sensitive_data: 'Sensitive data detected',
  tool_access: 'Tool access',
  permission_escalation: 'Permission escalation requested',
  model_violation: 'Unapproved model',
  blocked_request: 'Request blocked',
  redacted_request: 'Request redacted',
  runtime_alert: 'Runtime alert',
  anomalous_activity: 'Anomalous activity',
  system_event: 'System event',
};

export const guardActionLabels: Record<GuardActionTaken, string> = {
  allow: 'Allowed',
  monitor: 'Monitored',
  warn: 'Warning',
  redact: 'Redacted',
  block: 'Blocked',
  require_approval: 'Approval required',
  route: 'Rerouted',
  log: 'Logged',
};

export const guardStatusLabels: Record<GuardStatus, string> = {
  protected: 'Protected',
  monitored: 'Monitored',
  unprotected: 'Unprotected',
  unknown: 'Unknown',
};

export const guardRuntimeLabels: Record<GuardRuntime, string> = {
  vhalcha_gateway: 'Vhalcha Gateway',
  direct: 'Direct',
  external: 'External',
  unknown: 'Unknown',
};

export const guardDataCategoryLabels: Record<string, string> = {
  pii: 'Personally identifiable information',
  financial: 'Financial information',
  secrets: 'Authentication secrets',
  health: 'Health information',
  confidential: 'Company confidential',
  source_code: 'Source code',
  custom: 'Custom classifications',
};
