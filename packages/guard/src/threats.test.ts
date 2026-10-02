import { describe, expect, it } from 'vitest';
import { describeEffectiveBehaviour } from './policy';
import { classifyGuardThreat, explainGuardThreat, GUARD_FAIL_CLOSED_CRITICAL_COUNT } from './threats';

describe('guard threat classification', () => {
  it('does not turn request inspection into a threat', () => {
    expect(classifyGuardThreat({ eventType: 'system_event', evidence: { outcome: 'continued' } })).toBeNull();
  });

  it('classifies email, cards, secrets, blocks and enforcement failures', () => {
    expect(classifyGuardThreat({ eventType: 'sensitive_data', evidence: { classification: 'CUSTOMER_PII', outcome: 'would_enforce' } })).toMatchObject({
      type: 'sensitive_data_exposure',
      severity: 'medium',
    });
    expect(classifyGuardThreat({ eventType: 'sensitive_data', evidence: { classification: 'PAYMENT_CARD', outcome: 'blocked' } })).toMatchObject({
      type: 'sensitive_data_exposure',
      severity: 'high',
    });
    expect(classifyGuardThreat({ eventType: 'sensitive_data', dataCategory: 'secrets', evidence: { classification: 'PRIVATE_KEY', outcome: 'redacted' } })).toMatchObject({
      type: 'secret_exposure',
      severity: 'high',
    });
    expect(classifyGuardThreat({ eventType: 'blocked_request', evidence: { outcome: 'blocked' } })).toMatchObject({
      type: 'policy_violation',
      severity: 'high',
    });
    expect(classifyGuardThreat({ eventType: 'redacted_request', evidence: { classification: 'CUSTOMER_PII', outcome: 'redacted' } })).toMatchObject({
      type: 'sensitive_data_exposure',
      severity: 'medium',
    });
    expect(classifyGuardThreat({ eventType: 'policy_violation', evidence: { outcome: 'would_enforce' } })).toMatchObject({
      type: 'policy_violation',
      severity: 'medium',
    });
    expect(classifyGuardThreat({ eventType: 'runtime_alert', evidence: { outcome: 'failed_closed' } })).toMatchObject({
      type: 'runtime_enforcement_failure',
      severity: 'high',
    });
    expect(
      classifyGuardThreat({
        eventType: 'runtime_alert',
        evidence: { outcome: 'failed_closed' },
        failClosedCount: GUARD_FAIL_CLOSED_CRITICAL_COUNT,
      })?.severity,
    ).toBe('critical');
  });

  it('explains redaction without the original value', () => {
    const text = explainGuardThreat({
      type: 'sensitive_data_exposure',
      systemName: 'Customer Support Agent',
      policyName: 'Customer PII Protection',
      policyVersion: 3,
      classifications: ['CUSTOMER_PII'],
      outcome: 'redacted',
      redactionSummary: 'EMAIL=1',
      enforcementExecuted: true,
    });
    expect(text.action).toContain('REDACTED');
    expect(text.action).toContain('1 email');
    expect(JSON.stringify(text)).not.toContain('jane@');
  });
});

describe('policy builder runtime language', () => {
  it('describes monitor and protect from the real gateway connection', () => {
    expect(
      describeEffectiveBehaviour({
        action: 'redact',
        policyMode: 'enforce',
        organisationMode: 'monitor',
        enforcementConnected: true,
      }),
    ).toContain('WOULD REDACT');
    expect(
      describeEffectiveBehaviour({
        action: 'redact',
        policyMode: 'enforce',
        organisationMode: 'monitor',
        enforcementConnected: true,
      }),
    ).toContain('currently in Monitor mode');
    expect(
      describeEffectiveBehaviour({
        action: 'redact',
        policyMode: 'enforce',
        organisationMode: 'protect',
        enforcementConnected: true,
      }),
    ).toContain('Vhalcha Gateway supports this enforcement action');
    expect(
      describeEffectiveBehaviour({
        action: 'require_approval',
        policyMode: 'enforce',
        organisationMode: 'protect',
        enforcementConnected: true,
      }),
    ).toContain('Not yet available');
  });
});
