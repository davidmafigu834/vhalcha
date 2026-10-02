import { sanitizeGuardText } from './sanitize';
import type { GuardMode, GuardSeverity } from './types';

export const guardPolicyCategories = [
  'data',
  'provider',
  'model',
  'prompt',
  'tool',
  'agent',
  'access',
  'runtime',
  'security',
] as const;
export type GuardPolicyCategory = (typeof guardPolicyCategories)[number];

export const guardPolicyStatuses = ['draft', 'active', 'disabled'] as const;
export type GuardPolicyStatus = (typeof guardPolicyStatuses)[number];

export const guardPolicyModes = ['monitor', 'enforce'] as const;
export type GuardPolicyMode = (typeof guardPolicyModes)[number];

export const guardPolicyActionTypes = [
  'allow',
  'monitor',
  'warn',
  'redact',
  'block',
  'require_approval',
  'route',
  'log',
  'create_incident',
] as const;
export type GuardPolicyActionType = (typeof guardPolicyActionTypes)[number];

export const operationalGuardActions = ['allow', 'monitor', 'warn', 'log'] as const;

export const guardDecisionKinds = [
  'allow',
  'monitor',
  'warn',
  'redact',
  'block',
  'require_approval',
  'route',
] as const;
export type GuardDecisionKind = (typeof guardDecisionKinds)[number];

export const guardPolicyOperators = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'exists',
  'not_exists',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
] as const;
export type GuardPolicyOperator = (typeof guardPolicyOperators)[number];

export const guardPolicyFields = [
  'system.id',
  'system.type',
  'system.riskLevel',
  'environment',
  'provider.id',
  'provider.name',
  'model.id',
  'model.name',
  'request.detectedDataTypes',
  'request.detectedSecrets',
  'request.promptRiskFlags',
  'request.detectedDataCount',
  'tool.name',
  'tool.category',
  'tool.riskLevel',
  'actor.userId',
  'actor.role',
  'runtime.id',
  'runtime.type',
] as const;
export type GuardPolicyField = (typeof guardPolicyFields)[number];

export type GuardFieldValueType = 'string' | 'string_list' | 'number';

const stringOperators = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'exists',
  'not_exists',
] as const satisfies readonly GuardPolicyOperator[];

const listOperators = ['contains', 'not_contains', 'exists', 'not_exists'] as const satisfies readonly GuardPolicyOperator[];

const numberOperators = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'exists',
  'not_exists',
] as const satisfies readonly GuardPolicyOperator[];

export const guardPolicyFieldRegistry: Record<
  GuardPolicyField,
  { label: string; valueType: GuardFieldValueType; operators: readonly GuardPolicyOperator[] }
> = {
  'system.id': { label: 'AI system', valueType: 'string', operators: stringOperators },
  'system.type': { label: 'AI system type', valueType: 'string', operators: stringOperators },
  'system.riskLevel': { label: 'AI system risk', valueType: 'string', operators: stringOperators },
  environment: { label: 'Environment', valueType: 'string', operators: stringOperators },
  'provider.id': { label: 'Provider', valueType: 'string', operators: stringOperators },
  'provider.name': { label: 'Provider name', valueType: 'string', operators: stringOperators },
  'model.id': { label: 'Model', valueType: 'string', operators: stringOperators },
  'model.name': { label: 'Model name', valueType: 'string', operators: stringOperators },
  'request.detectedDataTypes': { label: 'Detected data', valueType: 'string_list', operators: listOperators },
  'request.detectedSecrets': { label: 'Detected secrets', valueType: 'string_list', operators: listOperators },
  'request.promptRiskFlags': { label: 'Prompt risk flags', valueType: 'string_list', operators: listOperators },
  'request.detectedDataCount': { label: 'Detected data count', valueType: 'number', operators: numberOperators },
  'tool.name': { label: 'Tool', valueType: 'string', operators: stringOperators },
  'tool.category': { label: 'Tool category', valueType: 'string', operators: stringOperators },
  'tool.riskLevel': { label: 'Tool risk', valueType: 'string', operators: stringOperators },
  'actor.userId': { label: 'User', valueType: 'string', operators: stringOperators },
  'actor.role': { label: 'Actor role', valueType: 'string', operators: stringOperators },
  'runtime.id': { label: 'Runtime', valueType: 'string', operators: stringOperators },
  'runtime.type': { label: 'Runtime type', valueType: 'string', operators: stringOperators },
};

export const guardEnvironments = ['development', 'staging', 'production'] as const;
export type GuardEnvironmentName = (typeof guardEnvironments)[number];

export const GUARD_POLICY_MAX_DEPTH = 3;
export const GUARD_POLICY_MAX_NODES = 40;
export const GUARD_POLICY_PRIORITY_DEFAULT = 100;

/**
 * Higher numeric priority wins. Same priority uses action restrictiveness, then policy id.
 * The policy tester keeps enforcementConnected false so a test run does not execute.
 * The gateway passes its own flag after Protect is explicitly enabled.
 */
export const guardLiveEnforcement = { connected: false };

const gatewayExecutedActions = new Set<GuardPolicyActionType>(['allow', 'monitor', 'warn', 'log', 'block', 'redact']);

const actionRank: Record<GuardPolicyActionType, number> = {
  block: 80,
  require_approval: 70,
  redact: 60,
  route: 50,
  warn: 40,
  create_incident: 30,
  log: 20,
  monitor: 20,
  allow: 10,
};

export interface GuardPolicyScope {
  organizationWide?: boolean;
  systemIds?: string[];
  teamIds?: string[];
  environments?: GuardEnvironmentName[];
  providers?: string[];
  models?: string[];
}

export interface GuardPolicyCondition {
  field: GuardPolicyField;
  operator: GuardPolicyOperator;
  value?: string | number | string[];
}

export interface GuardConditionGroup {
  logic: 'all' | 'any';
  conditions: Array<GuardPolicyCondition | GuardConditionGroup>;
}

export interface GuardPolicyActionConfig {
  dataTypes?: string[];
  routeProviderId?: string;
  routeModelId?: string;
  approvalGroup?: string;
  incidentSeverity?: GuardSeverity;
  message?: string;
}

export interface GuardPolicyAction {
  type: GuardPolicyActionType;
  config?: GuardPolicyActionConfig;
}

export interface GuardPolicyDocument {
  scope: GuardPolicyScope;
  conditions: GuardConditionGroup;
  actions: GuardPolicyAction[];
}

export interface GuardEvaluationContext {
  organizationId: string;
  requestId?: string;
  traceId?: string;
  system?: { id: string; type?: string; riskLevel?: string };
  actor?: { userId?: string; role?: string; serviceId?: string };
  team?: { id?: string };
  environment?: string;
  provider?: { id?: string; name?: string };
  model?: { id?: string; name?: string };
  request?: {
    detectedDataTypes?: string[];
    detectedSecrets?: string[];
    promptRiskFlags?: string[];
    detectedDataCount?: number;
  };
  tool?: { name?: string; category?: string; riskLevel?: string };
  runtime?: { id?: string; type?: string };
}

export interface CompiledGuardPolicy {
  organizationId: string;
  policyId: string;
  policyVersionId: string;
  name: string;
  version: number;
  priority: number;
  mode: GuardPolicyMode;
  document: GuardPolicyDocument;
}

export interface GuardPolicyMatch {
  policyId: string;
  policyVersionId: string;
  name: string;
  version: number;
  priority: number;
  action: GuardPolicyActionType;
  mode: GuardPolicyMode;
}

export interface GuardDecision {
  id: string;
  organizationId: string;
  decision: GuardDecisionKind;
  matchedPolicies: GuardPolicyMatch[];
  reasons: string[];
  effectiveMode: 'monitor' | 'enforce';
  wouldEnforce?: { action: GuardPolicyActionType; policyId: string };
  enforcementExecuted: boolean;
  evaluationMs: number;
  policiesConsidered: number;
  policiesMatched: number;
  evaluatedAt: Date;
}

export class GuardPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardPolicyValidationError';
  }
}

export function isConditionGroup(value: GuardPolicyCondition | GuardConditionGroup): value is GuardConditionGroup {
  return 'logic' in value;
}

export function readPolicyField(context: GuardEvaluationContext, field: GuardPolicyField): unknown {
  switch (field) {
    case 'system.id':
      return context.system?.id;
    case 'system.type':
      return context.system?.type;
    case 'system.riskLevel':
      return context.system?.riskLevel;
    case 'environment':
      return context.environment;
    case 'provider.id':
      return context.provider?.id;
    case 'provider.name':
      return context.provider?.name;
    case 'model.id':
      return context.model?.id;
    case 'model.name':
      return context.model?.name;
    case 'request.detectedDataTypes':
      return context.request?.detectedDataTypes;
    case 'request.detectedSecrets':
      return context.request?.detectedSecrets;
    case 'request.promptRiskFlags':
      return context.request?.promptRiskFlags;
    case 'request.detectedDataCount':
      return context.request?.detectedDataCount;
    case 'tool.name':
      return context.tool?.name;
    case 'tool.category':
      return context.tool?.category;
    case 'tool.riskLevel':
      return context.tool?.riskLevel;
    case 'actor.userId':
      return context.actor?.userId;
    case 'actor.role':
      return context.actor?.role;
    case 'runtime.id':
      return context.runtime?.id;
    case 'runtime.type':
      return context.runtime?.type;
    default:
      return undefined;
  }
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function compareCondition(condition: GuardPolicyCondition, actual: unknown): boolean {
  const { operator, value } = condition;
  if (operator === 'exists') return present(actual);
  if (operator === 'not_exists') return !present(actual);
  if (!present(actual) && operator !== 'not_equals') return false;
  if (Array.isArray(actual)) {
    const expected = typeof value === 'string' ? value : '';
    if (operator === 'contains') return actual.map(String).includes(expected);
    if (operator === 'not_contains') return !actual.map(String).includes(expected);
    return false;
  }
  if (typeof actual === 'number') {
    const expected = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(expected)) return false;
    if (operator === 'equals') return actual === expected;
    if (operator === 'not_equals') return actual !== expected;
    if (operator === 'greater_than') return actual > expected;
    if (operator === 'greater_than_or_equal') return actual >= expected;
    if (operator === 'less_than') return actual < expected;
    if (operator === 'less_than_or_equal') return actual <= expected;
    return false;
  }
  const text = asText(actual);
  if (operator === 'equals') return text === value;
  if (operator === 'not_equals') return present(actual) && text !== value;
  if (operator === 'contains') return typeof value === 'string' && text.includes(value);
  if (operator === 'not_contains') return typeof value === 'string' && !text.includes(value);
  if (operator === 'in') return Array.isArray(value) && value.map(String).includes(text);
  if (operator === 'not_in') return present(actual) && Array.isArray(value) && !value.map(String).includes(text);
  return false;
}

export function evaluateConditionGroup(group: GuardConditionGroup, context: GuardEvaluationContext, depth = 1): boolean {
  if (depth > GUARD_POLICY_MAX_DEPTH || group.conditions.length === 0) return false;
  const results = group.conditions.map((entry) =>
    isConditionGroup(entry) ? evaluateConditionGroup(entry, context, depth + 1) : compareCondition(entry, readPolicyField(context, entry.field)),
  );
  return group.logic === 'any' ? results.some(Boolean) : results.every(Boolean);
}

export function scopeMatches(scope: GuardPolicyScope, context: GuardEvaluationContext): boolean {
  if (!scope.organizationWide && (scope.systemIds?.length ?? 0) > 0) {
    if (!context.system?.id || !scope.systemIds?.includes(context.system.id)) return false;
  }
  if ((scope.teamIds?.length ?? 0) > 0) {
    if (!context.team?.id || !scope.teamIds?.includes(context.team.id)) return false;
  }
  if ((scope.environments?.length ?? 0) > 0) {
    if (!context.environment || !scope.environments?.includes(context.environment as GuardEnvironmentName)) return false;
  }
  if ((scope.providers?.length ?? 0) > 0) {
    if (!context.provider?.id || !scope.providers?.includes(context.provider.id)) return false;
  }
  if ((scope.models?.length ?? 0) > 0) {
    const modelId = context.model?.id;
    const modelName = context.model?.name;
    const allowed = scope.models ?? [];
    if (!((modelId && allowed.includes(modelId)) || (modelName && allowed.includes(modelName)))) return false;
  }
  return true;
}

export function primaryAction(actions: GuardPolicyAction[]): GuardPolicyAction {
  return [...actions].sort((left, right) => actionRank[right.type] - actionRank[left.type] || left.type.localeCompare(right.type))[0] ?? {
    type: 'allow',
  };
}

function restrictive(action: GuardPolicyActionType): boolean {
  return !operationalGuardActions.includes(action as (typeof operationalGuardActions)[number]);
}

export function decisionLabel(decision: Pick<GuardDecision, 'decision' | 'wouldEnforce' | 'enforcementExecuted'>): string {
  if (decision.wouldEnforce && !decision.enforcementExecuted) {
    return `WOULD ${decision.wouldEnforce.action.replaceAll('_', ' ').toUpperCase()}`;
  }
  return decision.decision.replaceAll('_', ' ').toUpperCase();
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => sanitizeGuardText(String(item), 80)).join(', ') || 'none';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return sanitizeGuardText(value, 120) || 'empty';
  return 'not provided';
}

const operatorPhrase: Record<GuardPolicyOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  in: 'is in',
  not_in: 'is not in',
  exists: 'is present',
  not_exists: 'is absent',
  greater_than: 'is greater than',
  greater_than_or_equal: 'is at least',
  less_than: 'is less than',
  less_than_or_equal: 'is at most',
};

function describeNode(node: GuardPolicyCondition | GuardConditionGroup, context?: GuardEvaluationContext): string {
  if (isConditionGroup(node)) {
    const joiner = node.logic === 'any' ? ' or ' : ' and ';
    return node.conditions.map((entry) => describeNode(entry, context)).join(joiner);
  }
  const label = guardPolicyFieldRegistry[node.field].label;
  const expected =
    node.operator === 'exists' || node.operator === 'not_exists' ? '' : ` ${formatValue(node.value)}`;
  const observed = context ? ` Observed ${formatValue(readPolicyField(context, node.field))}.` : '';
  return `${label} ${operatorPhrase[node.operator]}${expected}.${observed}`;
}

export function summarizePolicyDocument(name: string, document: GuardPolicyDocument, systemNames?: Map<string, string>): string {
  const scopeParts: string[] = [];
  if (document.scope.organizationWide) scopeParts.push('the entire organisation');
  else if ((document.scope.systemIds?.length ?? 0) > 0) {
    const names = (document.scope.systemIds ?? []).map((id) => systemNames?.get(id) ?? 'a selected AI system');
    scopeParts.push(names.join(', '));
  }
  if ((document.scope.environments?.length ?? 0) > 0) scopeParts.push(document.scope.environments?.join(', ') ?? '');
  if ((document.scope.providers?.length ?? 0) > 0) scopeParts.push(`providers ${document.scope.providers?.join(', ')}`);
  if ((document.scope.models?.length ?? 0) > 0) scopeParts.push(`models ${document.scope.models?.join(', ')}`);
  if ((document.scope.teamIds?.length ?? 0) > 0) scopeParts.push('selected teams');
  const action = primaryAction(document.actions);
  const actionText: Record<GuardPolicyActionType, string> = {
    allow: 'allow the request',
    monitor: 'record the match',
    warn: 'record a warning',
    redact: 'redact the detected values',
    block: 'block the request',
    require_approval: 'require human approval',
    route: `route to provider ${action.config?.routeProviderId ?? 'a configured provider'}`,
    log: 'write an audit log',
    create_incident: 'open an incident',
  };
  const where = scopeParts.length > 0 ? `For ${scopeParts.join('; ')}: ` : '';
  return sanitizeGuardText(`${name}. ${where}If ${describeNode(document.conditions)} Guard should ${actionText[action.type]}.`, 900);
}

export function guardActionRuntimeSupport(action: GuardPolicyActionType): 'Vhalcha Gateway — Supported' | 'Not yet available' {
  return gatewayExecutedActions.has(action) ? 'Vhalcha Gateway — Supported' : 'Not yet available';
}

export function describeEffectiveBehaviour(input: {
  action: GuardPolicyActionType;
  policyMode: GuardPolicyMode;
  organisationMode: GuardMode;
  enforcementConnected: boolean;
}): string {
  const label = input.action.replaceAll('_', ' ').toUpperCase();
  if (!gatewayExecutedActions.has(input.action)) {
    return `Configured action: ${label}. Runtime support: Not yet available.`;
  }
  if (input.action === 'allow' || input.action === 'monitor' || input.action === 'log') {
    return `Effective behaviour: ${label}. Guard is connected to the Vhalcha Gateway. This action does not modify the request.`;
  }
  const executes =
    input.organisationMode === 'protect' && input.policyMode === 'enforce' && input.enforcementConnected;
  if (executes) {
    return `Effective behaviour: ${label}. Vhalcha Gateway supports this enforcement action.`;
  }
  if (input.policyMode !== 'enforce') {
    return `Effective behaviour: WOULD ${label}. Guard is connected to the Vhalcha Gateway, but this policy is in Monitor mode.`;
  }
  if (input.organisationMode !== 'protect') {
    return `Effective behaviour: WOULD ${label}. Guard is connected to the Vhalcha Gateway, but this organisation is currently in Monitor mode.`;
  }
  return `Effective behaviour: WOULD ${label}. Guard is connected to the Vhalcha Gateway, but Protect is not enabled for this deployment.`;
}

function newDecisionId(): string {
  return globalThis.crypto.randomUUID();
}

export function evaluatePolicies(input: {
  context: GuardEvaluationContext;
  policies: CompiledGuardPolicy[];
  organisationMode: GuardMode;
  enforcementConnected: boolean;
  modelAccessDenied?: boolean;
  now?: Date;
  decisionId?: string;
}): GuardDecision {
  const started = performance.now();
  const considered = input.policies.filter((policy) => policy.organizationId === input.context.organizationId);
  const matches = considered
    .filter((policy) => scopeMatches(policy.document.scope, input.context) && evaluateConditionGroup(policy.document.conditions, input.context))
    .sort((left, right) => right.priority - left.priority || left.policyId.localeCompare(right.policyId));
  const topPriority = matches[0]?.priority;
  const top = matches.filter((policy) => policy.priority === topPriority);
  const ranked = [...top].sort((left, right) => {
    const rank = actionRank[primaryAction(right.document.actions).type] - actionRank[primaryAction(left.document.actions).type];
    if (rank !== 0) return rank;
    return left.policyId.localeCompare(right.policyId);
  });
  const winner = ranked[0];
  const winningAction = winner ? primaryAction(winner.document.actions).type : 'allow';
  const policyWantsEnforce = winner?.mode === 'enforce';
  const orgProtect = input.organisationMode === 'protect';
  const effectiveMode = winner && orgProtect && policyWantsEnforce ? 'enforce' : 'monitor';
  const holdBack =
    restrictive(winningAction) &&
    (!winner || winner.mode === 'monitor' || input.organisationMode !== 'protect' || !input.enforcementConnected);
  const decision: GuardDecisionKind = !winner
    ? 'allow'
    : winningAction === 'log' || winningAction === 'create_incident'
      ? 'monitor'
      : holdBack
        ? 'monitor'
        : (winningAction as GuardDecisionKind);
  const wouldEnforce =
    winner && restrictive(winningAction)
      ? { action: winningAction, policyId: winner.policyId }
      : undefined;
  const reasons: string[] = [];
  if (!winner) {
    reasons.push('No Guard policy matched. Existing model access rules still apply separately and are not overridden.');
  } else {
    reasons.push(
      sanitizeGuardText(
        `${winner.name} v${winner.version} matched. ${describeNode(winner.document.conditions, input.context)}`,
        700,
      ),
    );
    for (const other of matches.filter((policy) => policy.policyId !== winner.policyId)) {
      reasons.push(`${other.name} v${other.version} also matched at priority ${other.priority}.`);
    }
    reasons.push(
      describeEffectiveBehaviour({
        action: winningAction,
        policyMode: winner.mode,
        organisationMode: input.organisationMode,
        enforcementConnected: input.enforcementConnected,
      }),
    );
  }
  if (input.modelAccessDenied) {
    reasons.push('An existing model access rule denies this model. A Guard allow does not override that denial.');
  }
  reasons.push('No live request was modified.');
  return {
    id: input.decisionId ?? newDecisionId(),
    organizationId: input.context.organizationId,
    decision,
    matchedPolicies: matches.map((policy) => ({
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      name: policy.name,
      version: policy.version,
      priority: policy.priority,
      action: primaryAction(policy.document.actions).type,
      mode: policy.mode,
    })),
    reasons: reasons.map((reason) => sanitizeGuardText(reason, 700)),
    effectiveMode,
    wouldEnforce,
    enforcementExecuted: false,
    evaluationMs: Math.max(0, performance.now() - started),
    policiesConsidered: considered.length,
    policiesMatched: matches.length,
    evaluatedAt: input.now ?? new Date(),
  };
}

const slug = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

function cleanSlug(value: string, label: string): string {
  const cleaned = sanitizeGuardText(value, 80).trim();
  if (!slug.test(cleaned)) throw new GuardPolicyValidationError(`Invalid ${label}.`);
  return cleaned;
}

function countNodes(group: GuardConditionGroup, depth: number): number {
  if (depth > GUARD_POLICY_MAX_DEPTH) throw new GuardPolicyValidationError('Policy conditions are nested too deeply.');
  let count = 1;
  for (const entry of group.conditions) {
    count += isConditionGroup(entry) ? countNodes(entry, depth + 1) : 1;
  }
  if (count > GUARD_POLICY_MAX_NODES) throw new GuardPolicyValidationError('Policy has too many conditions.');
  return count;
}

function validateCondition(condition: GuardPolicyCondition): GuardPolicyCondition {
  const field = guardPolicyFields.find((item) => item === condition.field);
  if (!field) throw new GuardPolicyValidationError('Unknown policy field.');
  const spec = guardPolicyFieldRegistry[field];
  if (!spec.operators.includes(condition.operator)) {
    throw new GuardPolicyValidationError(`${spec.label} does not support that operator.`);
  }
  if (condition.operator === 'exists' || condition.operator === 'not_exists') {
    return { field, operator: condition.operator };
  }
  if (spec.valueType === 'number') {
    const numeric = typeof condition.value === 'number' ? condition.value : Number(condition.value);
    if (!Number.isFinite(numeric)) throw new GuardPolicyValidationError(`${spec.label} needs a number.`);
    return { field, operator: condition.operator, value: numeric };
  }
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    const values = Array.isArray(condition.value) ? condition.value : [];
    if (values.length === 0 || values.length > 20) throw new GuardPolicyValidationError(`${spec.label} needs a value list.`);
    return { field, operator: condition.operator, value: values.map((item) => cleanSlug(String(item), spec.label)) };
  }
  if (typeof condition.value !== 'string' || condition.value.trim().length === 0) {
    throw new GuardPolicyValidationError(`${spec.label} needs a value.`);
  }
  return { field, operator: condition.operator, value: cleanSlug(condition.value, spec.label) };
}

function validateGroup(group: GuardConditionGroup, depth = 1): GuardConditionGroup {
  if (group.logic !== 'all' && group.logic !== 'any') throw new GuardPolicyValidationError('Condition group logic must be all or any.');
  if (group.conditions.length === 0) throw new GuardPolicyValidationError('A condition group cannot be empty.');
  countNodes(group, depth);
  return {
    logic: group.logic,
    conditions: group.conditions.map((entry) => (isConditionGroup(entry) ? validateGroup(entry, depth + 1) : validateCondition(entry))),
  };
}

export function validatePolicyDocument(document: GuardPolicyDocument): GuardPolicyDocument {
  const scope = document.scope ?? {};
  const systemIds = (scope.systemIds ?? []).map((id) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GuardPolicyValidationError('Policy scope has an invalid AI system.');
    return id;
  });
  const teamIds = (scope.teamIds ?? []).map((id) => cleanSlug(id, 'team'));
  const environments = (scope.environments ?? []).map((environment) => {
    if (!guardEnvironments.includes(environment)) throw new GuardPolicyValidationError('Unknown environment.');
    return environment;
  });
  const providers = (scope.providers ?? []).map((provider) => cleanSlug(provider, 'provider'));
  const models = (scope.models ?? []).map((model) => cleanSlug(model, 'model'));
  if (!scope.organizationWide && systemIds.length + teamIds.length + environments.length + providers.length + models.length === 0) {
    throw new GuardPolicyValidationError('Choose a scope. An empty scope does not apply to every request.');
  }
  if (!document.actions || document.actions.length === 0 || document.actions.length > 4) {
    throw new GuardPolicyValidationError('Choose one policy action.');
  }
  const actions = document.actions.map((action) => {
    if (!guardPolicyActionTypes.includes(action.type)) throw new GuardPolicyValidationError('Unknown policy action.');
    const config: GuardPolicyActionConfig = {};
    if (action.type === 'route') {
      if (!action.config?.routeProviderId) throw new GuardPolicyValidationError('Route needs a destination provider.');
      config.routeProviderId = cleanSlug(action.config.routeProviderId, 'route provider');
      if (action.config.routeModelId) config.routeModelId = cleanSlug(action.config.routeModelId, 'route model');
    }
    if (action.config?.message) config.message = sanitizeGuardText(action.config.message, 240);
    if (action.config?.approvalGroup) config.approvalGroup = cleanSlug(action.config.approvalGroup, 'approval group');
    if (action.config?.incidentSeverity) config.incidentSeverity = action.config.incidentSeverity;
    if (action.config?.dataTypes) config.dataTypes = action.config.dataTypes.slice(0, 12).map((item) => cleanSlug(item, 'data type'));
    return { type: action.type, ...(Object.keys(config).length > 0 ? { config } : {}) };
  });
  return {
    scope: {
      organizationWide: Boolean(scope.organizationWide),
      ...(systemIds.length ? { systemIds } : {}),
      ...(teamIds.length ? { teamIds } : {}),
      ...(environments.length ? { environments } : {}),
      ...(providers.length ? { providers } : {}),
      ...(models.length ? { models } : {}),
    },
    conditions: validateGroup(document.conditions),
    actions,
  };
}

export function summarizeEvaluationContext(context: GuardEvaluationContext): Record<string, string | number | string[] | null> {
  const list = (values: string[] | undefined) => (values ?? []).slice(0, 12).map((value) => sanitizeGuardText(value, 64));
  return {
    systemId: context.system?.id ?? null,
    systemType: context.system?.type ? sanitizeGuardText(context.system.type, 40) : null,
    environment: context.environment ? sanitizeGuardText(context.environment, 40) : null,
    providerId: context.provider?.id ? sanitizeGuardText(context.provider.id, 64) : null,
    modelId: context.model?.id ? sanitizeGuardText(context.model.id, 80) : null,
    modelName: context.model?.name ? sanitizeGuardText(context.model.name, 80) : null,
    detectedDataTypes: list(context.request?.detectedDataTypes),
    detectedSecrets: list(context.request?.detectedSecrets),
    promptRiskFlags: list(context.request?.promptRiskFlags),
    toolName: context.tool?.name ? sanitizeGuardText(context.tool.name, 80) : null,
    toolRisk: context.tool?.riskLevel ? sanitizeGuardText(context.tool.riskLevel, 40) : null,
  };
}

const policyCache = new Map<string, { organizationId: string; version: number; policies: CompiledGuardPolicy[] }>();

export function policyCacheKey(organizationId: string, policySetVersion: number): string {
  if (!organizationId.trim()) throw new GuardPolicyValidationError('An organisation is required.');
  return `guard:policies:${organizationId}:${policySetVersion}`;
}

export function readPolicyCache(organizationId: string, policySetVersion: number): CompiledGuardPolicy[] | null {
  const hit = policyCache.get(policyCacheKey(organizationId, policySetVersion));
  if (!hit || hit.organizationId !== organizationId || hit.version !== policySetVersion) return null;
  if (hit.policies.some((policy) => policy.organizationId !== organizationId)) return null;
  return hit.policies;
}

export function writePolicyCache(organizationId: string, policySetVersion: number, policies: CompiledGuardPolicy[]): void {
  if (policies.some((policy) => policy.organizationId !== organizationId)) {
    throw new GuardPolicyValidationError('Refusing to cache another organisation’s policies.');
  }
  policyCache.set(policyCacheKey(organizationId, policySetVersion), {
    organizationId,
    version: policySetVersion,
    policies,
  });
}

export function invalidatePolicyCache(organizationId: string): void {
  const prefix = `guard:policies:${organizationId}:`;
  for (const key of policyCache.keys()) {
    if (key.startsWith(prefix)) policyCache.delete(key);
  }
}

export interface GuardPolicyTemplate {
  id: string;
  name: string;
  description: string;
  category: GuardPolicyCategory;
  priority: number;
  mode: GuardPolicyMode;
  document: GuardPolicyDocument;
  caution?: string;
}

export const guardPolicyTemplates: GuardPolicyTemplate[] = [
  {
    id: 'customer_pii',
    name: 'Customer PII Protection',
    description: 'Control whether personally identifiable customer information may be sent to selected AI providers.',
    category: 'data',
    priority: 300,
    mode: 'monitor',
    caution: 'Replace CONFIGURE_APPROVED_PROVIDER before relying on this draft.',
    document: {
      scope: { organizationWide: false, environments: ['production'] },
      conditions: {
        logic: 'all',
        conditions: [
          { field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' },
          { field: 'provider.id', operator: 'not_in', value: ['CONFIGURE_APPROVED_PROVIDER'] },
        ],
      },
      actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
    },
  },
  {
    id: 'secrets',
    name: 'Secrets Protection',
    description: 'Record when API keys, access tokens, private keys, or authentication secrets are present in a request context.',
    category: 'security',
    priority: 400,
    mode: 'monitor',
    document: {
      scope: { organizationWide: true },
      conditions: {
        logic: 'any',
        conditions: [
          { field: 'request.detectedSecrets', operator: 'contains', value: 'API_KEY' },
          { field: 'request.detectedSecrets', operator: 'contains', value: 'ACCESS_TOKEN' },
          { field: 'request.detectedSecrets', operator: 'contains', value: 'PRIVATE_KEY' },
          { field: 'request.detectedSecrets', operator: 'contains', value: 'AUTHENTICATION_SECRET' },
        ],
      },
      actions: [{ type: 'redact', config: { dataTypes: ['API_KEY', 'ACCESS_TOKEN', 'PRIVATE_KEY', 'AUTHENTICATION_SECRET'] } }],
    },
  },
  {
    id: 'approved_providers',
    name: 'Approved Providers',
    description: 'Restrict selected AI systems to approved providers. This does not replace existing model access rules.',
    category: 'provider',
    priority: 250,
    mode: 'monitor',
    caution: 'Replace CONFIGURE_APPROVED_PROVIDER with provider ids from your connections.',
    document: {
      scope: { organizationWide: true },
      conditions: {
        logic: 'all',
        conditions: [{ field: 'provider.id', operator: 'not_in', value: ['CONFIGURE_APPROVED_PROVIDER'] }],
      },
      actions: [{ type: 'block' }],
    },
  },
  {
    id: 'approved_models',
    name: 'Approved Models',
    description: 'Restrict selected AI systems to approved models. Existing model access rules remain authoritative.',
    category: 'model',
    priority: 250,
    mode: 'monitor',
    caution: 'Replace CONFIGURE_APPROVED_MODEL with a catalogue model id.',
    document: {
      scope: { organizationWide: true },
      conditions: {
        logic: 'all',
        conditions: [{ field: 'model.id', operator: 'not_in', value: ['CONFIGURE_APPROVED_MODEL'] }],
      },
      actions: [{ type: 'block' }],
    },
  },
  {
    id: 'production_controls',
    name: 'Production AI Controls',
    description: 'Apply a stricter recorded decision to production AI systems.',
    category: 'runtime',
    priority: 200,
    mode: 'monitor',
    document: {
      scope: { organizationWide: false, environments: ['production'] },
      conditions: {
        logic: 'all',
        conditions: [{ field: 'environment', operator: 'equals', value: 'production' }],
      },
      actions: [{ type: 'warn', config: { message: 'Production AI system matched the stricter control.' } }],
    },
  },
  {
    id: 'high_risk_tool',
    name: 'High-Risk Tool Approval',
    description: 'Require approval before an agent uses a tool marked high risk.',
    category: 'tool',
    priority: 350,
    mode: 'monitor',
    document: {
      scope: { organizationWide: true },
      conditions: {
        logic: 'all',
        conditions: [{ field: 'tool.riskLevel', operator: 'equals', value: 'high' }],
      },
      actions: [{ type: 'require_approval', config: { approvalGroup: 'security-admin' } }],
    },
  },
  {
    id: 'prompt_risk',
    name: 'Prompt Risk Monitoring',
    description: 'Monitor requests that a detector has flagged. This does not guarantee prompt-injection prevention.',
    category: 'prompt',
    priority: 150,
    mode: 'monitor',
    document: {
      scope: { organizationWide: true },
      conditions: {
        logic: 'all',
        conditions: [{ field: 'request.promptRiskFlags', operator: 'exists' }],
      },
      actions: [{ type: 'monitor' }],
    },
  },
];

export function policyTemplate(id: string): GuardPolicyTemplate | null {
  return guardPolicyTemplates.find((template) => template.id === id) ?? null;
}
