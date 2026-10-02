import { z } from 'zod';

export const organisationStatuses = ['active', 'suspended', 'closed'] as const;
export const userRoles = [
  'owner',
  'ai_admin',
  'developer',
  'security_admin',
  'finance_manager',
  'viewer',
] as const;
export const userStatuses = ['active', 'disabled'] as const;
export const environmentTypes = ['development', 'staging', 'production'] as const;
export const aiSystemTypes = ['application', 'agent', 'workflow', 'assistant', 'service'] as const;
export const aiSystemStatuses = ['active', 'disabled', 'attention', 'offline'] as const;
export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const virtualKeyStatuses = ['active', 'revoked', 'expired'] as const;
export const providers = ['openai'] as const;
export const credentialSources = ['platform_env', 'customer_managed', 'organisation', 'vhalcha_managed'] as const;
export const providerConnectionStatuses = ['active', 'disabled', 'error'] as const;
export const budgetPeriods = ['daily', 'monthly'] as const;
export const budgetActions = ['notify', 'block'] as const;
export const requestStatuses = ['pending', 'streaming', 'succeeded', 'failed', 'blocked'] as const;
export const policyResults = ['allowed', 'warning', 'blocked'] as const;
export const actorTypes = ['user', 'ai_system', 'api', 'system'] as const;
export const severities = ['info', 'warning', 'critical'] as const;
export const auditResults = ['success', 'failure', 'blocked'] as const;
export const contentLoggingModes = ['metadata_only'] as const;

export type OrganisationStatus = (typeof organisationStatuses)[number];
export type UserRole = (typeof userRoles)[number];
export type UserStatus = (typeof userStatuses)[number];
export type EnvironmentType = (typeof environmentTypes)[number];
export type AiSystemType = (typeof aiSystemTypes)[number];
export type AiSystemStatus = (typeof aiSystemStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type VirtualKeyStatus = (typeof virtualKeyStatuses)[number];
export type ProviderId = (typeof providers)[number];
export type CredentialSource = (typeof credentialSources)[number];
export type BudgetPeriod = (typeof budgetPeriods)[number];
export type BudgetAction = (typeof budgetActions)[number];
export type RequestStatus = (typeof requestStatuses)[number];
export type PolicyResult = (typeof policyResults)[number];
export type ActorType = (typeof actorTypes)[number];
export type Severity = (typeof severities)[number];
export type AuditResult = (typeof auditResults)[number];
export type ContentLoggingMode = (typeof contentLoggingModes)[number];

export const gatewayErrorCodes = [
  'invalid_api_key',
  'api_key_revoked',
  'system_disabled',
  'rate_limit_exceeded',
  'budget_exceeded',
  'model_not_allowed',
  'pricing_unknown',
  'provider_unavailable',
  'provider_error',
  'invalid_request',
  'internal_error',
  'organisation_unavailable',
  'control_plane_unavailable',
  'rate_limiter_unavailable',
  'idempotency_conflict',
  'idempotent_request_already_completed',
  'knowledge_unavailable',
  'no_compatible_model',
  'context_too_large',
  'provider_credentials_missing',
  'guard_policy_blocked',
  'guard_enforcement_unavailable',
] as const;

export type GatewayErrorCode = (typeof gatewayErrorCodes)[number];

export const gatewayErrorStatus: Record<GatewayErrorCode, number> = {
  invalid_api_key: 401,
  api_key_revoked: 401,
  system_disabled: 403,
  rate_limit_exceeded: 429,
  budget_exceeded: 402,
  model_not_allowed: 403,
  pricing_unknown: 403,
  provider_unavailable: 503,
  provider_error: 502,
  invalid_request: 400,
  internal_error: 500,
  organisation_unavailable: 403,
  control_plane_unavailable: 503,
  rate_limiter_unavailable: 503,
  idempotency_conflict: 409,
  idempotent_request_already_completed: 409,
  knowledge_unavailable: 503,
  no_compatible_model: 422,
  context_too_large: 400,
  provider_credentials_missing: 503,
  guard_policy_blocked: 403,
  guard_enforcement_unavailable: 403,
};

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly requestId: string | null;
  readonly details: Record<string, string>;

  constructor(
    code: GatewayErrorCode,
    message: string,
    headers: Record<string, string> = {},
    requestId: string | null = null,
    statusCode?: number,
    details: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode ?? gatewayErrorStatus[code];
    this.headers = headers;
    this.requestId = requestId;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.requestId ? { request_id: this.requestId } : {}),
        ...(this.details.decision_id ? { decision_id: this.details.decision_id } : {}),
        ...(this.details.policy ? { policy: this.details.policy } : {}),
      },
    };
  }
}

export const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(100_000),
  })
  .strict();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(128),
    messages: z.array(chatMessageSchema).min(1).max(100),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(128_000).optional(),
    stream: z.boolean().optional(),
    knowledge_space_ids: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const DEV_MODEL = 'gpt-4.1-mini';

export const permissions = [
  'organisations:read',
  'organisations:write',
  'users:read',
  'users:write',
  'environments:read',
  'environments:write',
  'ai_systems:read',
  'ai_systems:write',
  'api_keys:read',
  'api_keys:write',
  'gateway:read',
  'budgets:read',
  'budgets:write',
  'providers:read',
  'providers:write',
  'audit:read',
  'spend:read',
  'overview:read',
  'settings:read',
  'settings:developer',
  'ownership:transfer',
  'knowledge:read',
  'knowledge:write',
  'knowledge:manage_access',
  'routing:read',
  'routing:write',
  'routing:manage',
  'guard:view',
  'guard:configure',
  'guard:policy:create',
  'guard:policy:edit',
  'guard:policy:activate',
  'guard:incident:manage',
  'guard:approval:decide',
  'guard:runtime:configure',
  'guard:audit:view',
] as const;

export type Permission = (typeof permissions)[number];
