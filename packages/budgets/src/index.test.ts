import { describe, expect, it } from 'vitest';
import { estimateReservationTokens, evaluateBudgets, periodBounds, type BudgetSnapshot } from './index';

function snapshot(overrides: Partial<BudgetSnapshot>): BudgetSnapshot {
  return {
    id: 'budget',
    name: 'Monthly',
    period: 'monthly',
    amountUsd: 25,
    warningThresholdPercent: 80,
    hardLimit: true,
    action: 'block',
    spendUsd: 0,
    scope: 'ai_system',
    ...overrides,
  };
}

describe('evaluateBudgets', () => {
  it('allows spend below the warning threshold', () => {
    expect(evaluateBudgets([snapshot({ spendUsd: 10 })]).result).toBe('allowed');
  });

  it('warns at the threshold without blocking', () => {
    const decision = evaluateBudgets([snapshot({ spendUsd: 20, hardLimit: false, action: 'notify' })]);
    expect(decision.result).toBe('warning');
    expect(decision.warnings).toHaveLength(1);
  });

  it('blocks at a hard limit before the provider is called', () => {
    const decision = evaluateBudgets([snapshot({ spendUsd: 25 })]);
    expect(decision.result).toBe('blocked');
    expect(decision.blockedBy?.name).toBe('Monthly');
  });

  it('blocks when the budget action is block even if hard_limit is false', () => {
    const decision = evaluateBudgets([snapshot({ spendUsd: 25, hardLimit: false, action: 'block' })]);
    expect(decision.result).toBe('blocked');
  });
});

describe('estimateReservationTokens', () => {
  it('uses four characters per token and the client max_tokens cap', () => {
    expect(estimateReservationTokens([{ content: 'abcd' }], 10)).toEqual({ inputTokens: 1, outputTokens: 10 });
    expect(estimateReservationTokens([{ content: 'a' }]).outputTokens).toBe(256);
  });
});

describe('periodBounds', () => {
  it('uses the organisation timezone for the monthly window', () => {
    const bounds = periodBounds('monthly', 'America/New_York', new Date('2026-09-01T03:30:00.000Z'));
    expect(bounds.label).toBe('2026-08');
    expect(bounds.start.toISOString()).toBe('2026-08-01T04:00:00.000Z');
  });
});
