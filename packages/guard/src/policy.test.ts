import { describe, expect, it } from 'vitest';
import {
  decisionLabel,
  evaluateConditionGroup,
  evaluatePolicies,
  invalidatePolicyCache,
  readPolicyCache,
  scopeMatches,
  summarizeEvaluationContext,
  validatePolicyDocument,
  writePolicyCache,
  type CompiledGuardPolicy,
  type GuardEvaluationContext,
  type GuardPolicyDocument,
} from './policy';

const org = '00000000-0000-4000-8000-000000000001';
const system = '00000000-0000-4000-8000-000000000010';

function context(overrides: Partial<GuardEvaluationContext> = {}): GuardEvaluationContext {
  return {
    organizationId: org,
    system: { id: system, type: 'agent', riskLevel: 'medium' },
    environment: 'production',
    provider: { id: 'unapproved-provider', name: 'Unapproved Provider' },
    model: { id: 'model-1', name: 'Example Model' },
    request: { detectedDataTypes: ['CUSTOMER_PII'] },
    ...overrides,
  };
}

function policy(partial: Partial<CompiledGuardPolicy> & { document: GuardPolicyDocument }): CompiledGuardPolicy {
  return {
    organizationId: org,
    policyId: partial.policyId ?? 'policy-a',
    policyVersionId: partial.policyVersionId ?? 'version-a',
    name: partial.name ?? 'Customer PII Protection',
    version: partial.version ?? 1,
    priority: partial.priority ?? 100,
    mode: partial.mode ?? 'enforce',
    document: partial.document,
  };
}

const piiDocument: GuardPolicyDocument = {
  scope: { organizationWide: false, systemIds: [system], environments: ['production'] },
  conditions: {
    logic: 'all',
    conditions: [
      { field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' },
      { field: 'provider.id', operator: 'not_in', value: ['approved-provider'] },
    ],
  },
  actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
};

describe('policy conditions', () => {
  const base = context();
  it('matches equals, contains, in, exists and numeric comparisons', () => {
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] }, base)).toBe(true);
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'environment', operator: 'not_equals', value: 'development' }] }, base)).toBe(true);
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' }] }, base)).toBe(true);
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'request.detectedDataTypes', operator: 'not_contains', value: 'HEALTH' }] }, base)).toBe(true);
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'provider.id', operator: 'in', value: ['unapproved-provider'] }] }, base)).toBe(true);
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'provider.id', operator: 'not_in', value: ['approved-provider'] }] }, base)).toBe(true);
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'request.detectedSecrets', operator: 'exists' }] }, base)).toBe(false);
    expect(evaluateConditionGroup({ logic: 'all', conditions: [{ field: 'request.detectedSecrets', operator: 'not_exists' }] }, base)).toBe(true);
    expect(
      evaluateConditionGroup(
        { logic: 'all', conditions: [{ field: 'request.detectedDataCount', operator: 'greater_than', value: 1 }] },
        context({ request: { detectedDataCount: 2 } }),
      ),
    ).toBe(true);
    expect(
      evaluateConditionGroup(
        { logic: 'all', conditions: [{ field: 'request.detectedDataCount', operator: 'less_than_or_equal', value: 2 }] },
        context({ request: { detectedDataCount: 2 } }),
      ),
    ).toBe(true);
  });

  it('evaluates ALL, ANY and nested groups', () => {
    expect(evaluateConditionGroup(piiDocument.conditions, base)).toBe(true);
    expect(
      evaluateConditionGroup(
        { logic: 'any', conditions: [{ field: 'environment', operator: 'equals', value: 'development' }, { field: 'environment', operator: 'equals', value: 'production' }] },
        base,
      ),
    ).toBe(true);
    expect(
      evaluateConditionGroup(
        {
          logic: 'all',
          conditions: [
            { field: 'environment', operator: 'equals', value: 'production' },
            { logic: 'any', conditions: [{ field: 'provider.id', operator: 'equals', value: 'other' }, { field: 'provider.id', operator: 'equals', value: 'unapproved-provider' }] },
          ],
        },
        base,
      ),
    ).toBe(true);
  });

  it('rejects operators that do not belong to the field', () => {
    expect(() =>
      validatePolicyDocument({
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'request.detectedDataTypes', operator: 'greater_than', value: 1 }] },
        actions: [{ type: 'monitor' }],
      }),
    ).toThrow(/does not support/);
  });
});

describe('policy scope', () => {
  it('matches organisation, system, environment, provider and model scopes', () => {
    expect(scopeMatches({ organizationWide: true }, context())).toBe(true);
    expect(scopeMatches({ systemIds: [system] }, context())).toBe(true);
    expect(scopeMatches({ systemIds: ['00000000-0000-4000-8000-000000000099'] }, context())).toBe(false);
    expect(scopeMatches({ environments: ['production'] }, context())).toBe(true);
    expect(scopeMatches({ environments: ['development'] }, context())).toBe(false);
    expect(scopeMatches({ providers: ['unapproved-provider'] }, context())).toBe(true);
    expect(scopeMatches({ models: ['model-1'] }, context())).toBe(true);
    expect(scopeMatches({ providers: ['approved-provider'] }, context())).toBe(false);
  });
});

describe('policy decisions', () => {
  it('returns WOULD REDACT in organisation monitor mode without claiming a block', () => {
    const decision = evaluatePolicies({
      context: context(),
      policies: [policy({ document: piiDocument, mode: 'enforce', priority: 300 })],
      organisationMode: 'monitor',
      enforcementConnected: false,
    });
    expect(decision.decision).toBe('monitor');
    expect(decision.wouldEnforce).toEqual({ action: 'redact', policyId: 'policy-a' });
    expect(decision.enforcementExecuted).toBe(false);
    expect(decisionLabel(decision)).toBe('WOULD REDACT');
    expect(decision.reasons.join(' ')).toContain('Customer PII Protection v1');
    expect(decision.reasons.join(' ')).toContain('No live request was modified.');
    expect(decision.matchedPolicies[0]?.policyVersionId).toBe('version-a');
  });

  it('keeps policy monitor mode from becoming an enforce intent', () => {
    const decision = evaluatePolicies({
      context: context(),
      policies: [policy({ document: { ...piiDocument, actions: [{ type: 'block' }] }, mode: 'monitor' })],
      organisationMode: 'protect',
      enforcementConnected: true,
    });
    expect(decision.effectiveMode).toBe('monitor');
    expect(decision.wouldEnforce?.action).toBe('block');
    expect(decision.decision).toBe('monitor');
  });

  it('records enforce intent when the organisation is in protect and the policy is enforce', () => {
    const decision = evaluatePolicies({
      context: context(),
      policies: [policy({ document: piiDocument, mode: 'enforce' })],
      organisationMode: 'protect',
      enforcementConnected: true,
    });
    expect(decision.effectiveMode).toBe('enforce');
    expect(decision.decision).toBe('redact');
    expect(decision.enforcementExecuted).toBe(false);
    expect(decisionLabel(decision)).toBe('WOULD REDACT');
  });

  it('returns warn and route as decisions without executing them', () => {
    const warn = evaluatePolicies({
      context: context(),
      policies: [
        policy({
          document: {
            scope: { organizationWide: true },
            conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
            actions: [{ type: 'warn', config: { message: 'Review this request.' } }],
          },
          mode: 'enforce',
        }),
      ],
      organisationMode: 'protect',
      enforcementConnected: true,
    });
    expect(warn.decision).toBe('warn');
    expect(warn.enforcementExecuted).toBe(false);
    const routed = evaluatePolicies({
      context: context(),
      policies: [
        policy({
          document: {
            scope: { organizationWide: true },
            conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
            actions: [{ type: 'route', config: { routeProviderId: 'approved-provider' } }],
          },
          mode: 'enforce',
        }),
      ],
      organisationMode: 'monitor',
      enforcementConnected: false,
    });
    expect(routed.decision).toBe('monitor');
    expect(routed.wouldEnforce?.action).toBe('route');
    expect(decisionLabel(routed)).toBe('WOULD ROUTE');
  });

  it('allows when nothing matches and does not override a model access denial', () => {
    const decision = evaluatePolicies({
      context: context({ request: { detectedDataTypes: [] } }),
      policies: [policy({ document: piiDocument })],
      organisationMode: 'monitor',
      enforcementConnected: false,
      modelAccessDenied: true,
    });
    expect(decision.decision).toBe('allow');
    expect(decision.reasons.join(' ')).toContain('does not override');
  });

  it('lets the higher priority win and breaks ties by restrictiveness', () => {
    const allow = policy({
      policyId: 'allow',
      name: 'Allow sales model',
      priority: 100,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'allow' }],
      },
    });
    const block = policy({
      policyId: 'block',
      name: 'Block external models',
      priority: 300,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'block' }],
      },
    });
    const higher = evaluatePolicies({
      context: context(),
      policies: [allow, block],
      organisationMode: 'protect',
      enforcementConnected: true,
    });
    expect(higher.wouldEnforce?.policyId).toBe('block');
    const warn = policy({
      policyId: 'warn-z',
      name: 'Warn',
      priority: 200,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'warn' }],
      },
    });
    const approval = policy({
      policyId: 'approval-a',
      name: 'Approval',
      priority: 200,
      document: {
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'require_approval' }],
      },
    });
    const tie = evaluatePolicies({
      context: context(),
      policies: [warn, approval],
      organisationMode: 'protect',
      enforcementConnected: true,
    });
    expect(tie.wouldEnforce?.policyId).toBe('approval-a');
    expect(tie.matchedPolicies).toHaveLength(2);
  });
});

describe('policy validation and sanitising', () => {
  it('rejects a route action without a destination and strips secrets from summaries', () => {
    expect(() =>
      validatePolicyDocument({
        scope: { organizationWide: true },
        conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
        actions: [{ type: 'route' }],
      }),
    ).toThrow(/destination provider/);
    const summary = summarizeEvaluationContext(context({ provider: { id: 'sk-live-abcdefghijklmnop' }, request: { detectedDataTypes: ['4111111111111111'] } }));
    expect(JSON.stringify(summary)).not.toContain('sk-live');
    expect(JSON.stringify(summary)).not.toContain('4111111111111111');
  });
});

describe('policy cache', () => {
  it('does not return one organisation cache entry to another', () => {
    const compiled = [policy({ document: piiDocument })];
    writePolicyCache(org, 3, compiled);
    expect(readPolicyCache(org, 3)).toHaveLength(1);
    expect(readPolicyCache('00000000-0000-4000-8000-000000000002', 3)).toBeNull();
    invalidatePolicyCache(org);
    expect(readPolicyCache(org, 3)).toBeNull();
    expect(() => writePolicyCache(org, 4, [{ ...compiled[0]!, organizationId: 'other-org' }])).toThrow(/another organisation/);
  });
});

describe('evaluation cost', () => {
  it('evaluates a modest active set quickly', () => {
    const policies = Array.from({ length: 25 }, (_, index) =>
      policy({
        policyId: `policy-${index}`,
        priority: index + 1,
        document: {
          scope: { organizationWide: true },
          conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: index === 24 ? 'production' : 'staging' }] },
          actions: [{ type: 'monitor' }],
        },
      }),
    );
    const decision = evaluatePolicies({
      context: context(),
      policies,
      organisationMode: 'monitor',
      enforcementConnected: false,
    });
    expect(decision.policiesConsidered).toBe(25);
    expect(decision.evaluationMs).toBeLessThan(200);
  });
});
