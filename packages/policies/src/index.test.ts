import { describe, expect, it } from 'vitest';
import { calculatePolicyCompliance, decideModelAccess } from './index';

describe('decideModelAccess', () => {
  const rules = [
    {
      id: 'allow-mini',
      provider: 'openai',
      modelPattern: 'gpt-4.1-mini',
      isAllowed: true,
      priority: 100,
    },
    {
      id: 'deny-all',
      provider: 'openai',
      modelPattern: 'gpt-*',
      isAllowed: false,
      priority: 200,
    },
  ];

  it('allows a model that matches an allow rule', () => {
    expect(decideModelAccess(rules, 'openai', 'gpt-4.1-mini').allowed).toBe(true);
  });

  it('blocks a model outside the allow rule', () => {
    const decision = decideModelAccess(rules, 'openai', 'gpt-4o');
    expect(decision.allowed).toBe(false);
    expect(decision.matchedRule?.id).toBe('deny-all');
  });

  it('denies when no rule matches', () => {
    expect(decideModelAccess(rules, 'openai', 'o1-preview').allowed).toBe(false);
  });

  it('lets a higher-priority deny override a broader allow', () => {
    const decision = decideModelAccess(
      [
        { id: 'allow', provider: 'openai', modelPattern: 'gpt-*', isAllowed: true, priority: 50 },
        { id: 'deny', provider: 'openai', modelPattern: 'gpt-4o', isAllowed: false, priority: 10 },
      ],
      'openai',
      'gpt-4o',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.matchedRule?.id).toBe('deny');
  });
});

describe('calculatePolicyCompliance', () => {
  it('does not invent a perfect score when there is no traffic', () => {
    expect(
      calculatePolicyCompliance({
        allowedRequests: 0,
        blockedRequests: 0,
        warningEvents: 0,
        systemsRequiringAttention: 0,
        totalSystems: 1,
      }).label,
    ).toBe('No evaluated traffic');
  });

  it('drops to review required when blocked requests dominate', () => {
    const result = calculatePolicyCompliance({
      allowedRequests: 1,
      blockedRequests: 9,
      warningEvents: 2,
      systemsRequiringAttention: 1,
      totalSystems: 2,
    });
    expect(result.label).toBe('Review required');
    expect(result.score).not.toBeNull();
  });
});
