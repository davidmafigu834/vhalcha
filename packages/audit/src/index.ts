export const auditActions = {
  requestCompleted: 'gateway.request.completed',
  requestBlocked: 'gateway.request.blocked',
  requestFailed: 'gateway.request.failed',
  rateLimitExceeded: 'gateway.rate_limit.exceeded',
  keyCreated: 'api_key.created',
  keyRevoked: 'api_key.revoked',
  keyRotated: 'api_key.rotated',
  systemCreated: 'ai_system.created',
  systemStatusChanged: 'ai_system.status_changed',
  budgetUpdated: 'budget.updated',
  userSignedIn: 'user.signed_in',
  passwordResetRequested: 'user.password_reset_requested',
  userRoleChanged: 'user.role_changed',
  budgetReservationOverrun: 'budget.reservation.overrun',
  budgetReconciliationRequired: 'budget.reconciliation_required',
  knowledgeSpaceCreated: 'knowledge.space.created',
  knowledgeSpaceUpdated: 'knowledge.space.updated',
  knowledgeSpaceArchived: 'knowledge.space.archived',
  knowledgeDocumentUploaded: 'knowledge.document.uploaded',
  knowledgeDocumentVersionCreated: 'knowledge.document.version_created',
  knowledgeDocumentIndexed: 'knowledge.document.indexed',
  knowledgeDocumentFailed: 'knowledge.document.failed',
  knowledgeDocumentArchived: 'knowledge.document.archived',
  knowledgeAccessGranted: 'knowledge.access.granted',
  knowledgeAccessRevoked: 'knowledge.access.revoked',
  knowledgeEvidenceInsufficient: 'knowledge.evidence.insufficient',
  knowledgeRetrievalFailed: 'knowledge.retrieval.failed',
  routingDecisionCreated: 'routing.decision.created',
  routingFallbackStarted: 'routing.fallback.started',
  routingFallbackCompleted: 'routing.fallback.completed',
  routingFallbackFailed: 'routing.fallback.failed',
  routingPolicyUpdated: 'routing.policy.updated',
  routingModelAllowed: 'routing.model.allowed',
  routingModelBlocked: 'routing.model.blocked',
  providerConnectionCreated: 'provider.connection.created',
  providerConnectionDisabled: 'provider.connection.disabled',
  providerVerificationStarted: 'provider.verification.started',
  providerVerificationSucceeded: 'provider.verification.succeeded',
  providerVerificationFailed: 'provider.verification.failed',
  guardSettingsUpdated: 'guard.settings.updated',
  guardProfileUpdated: 'guard.system.profile_updated',
  guardEventExpected: 'guard.event.marked_expected',
  guardPolicyCreated: 'guard.policy.created',
  guardPolicyUpdated: 'guard.policy.updated',
  guardPolicyActivated: 'guard.policy.activated',
  guardPolicyDisabled: 'guard.policy.disabled',
  guardPolicyDeleted: 'guard.policy.deleted',
  guardThreatStatusChanged: 'guard.threat.status_changed',
  guardThreatAssigned: 'guard.threat.assigned',
  guardIncidentCreated: 'guard.incident.created',
  guardIncidentAssigned: 'guard.incident.assigned',
  guardIncidentStatusChanged: 'guard.incident.status_changed',
} as const;

export interface AuditDraft {
  organisationId: string;
  environmentId?: string | null;
  actorType: 'user' | 'ai_system' | 'api' | 'system';
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  result: 'success' | 'failure' | 'blocked';
  severity: 'info' | 'warning' | 'critical';
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

const blockedMetadataKeys = /prompt|response|message|content|authorization|api[-_]?key|secret|password/i;

export function safeAuditMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (blockedMetadataKeys.test(key)) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    }
  }
  return output;
}
