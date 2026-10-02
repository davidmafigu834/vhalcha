import { describe, expect, it } from 'vitest';
import { applyGuardEnforcement } from './enforce';
import { inspectGuardRequest, redactGuardText, redactGuardValue } from './inspect';
import { evaluatePolicies, type CompiledGuardPolicy, type GuardPolicyDocument } from './policy';

const validCard = '4111111111111111';
const invalidCard = '4111111111111112';

describe('guard inspectors', () => {
  it('detects email, phone and a Luhn-valid card without keeping the value', () => {
    const result = inspectGuardRequest({
      messages: [{ role: 'user', content: `Email jane@example.com call 415-555-0134 card ${validCard}` }],
    });
    expect(result.detectedDataTypes).toEqual(expect.arrayContaining(['CUSTOMER_PII', 'PAYMENT_CARD']));
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
    expect(JSON.stringify(result)).not.toContain(validCard);
    expect(result.findings.find((finding) => finding.marker === 'EMAIL')?.count).toBe(1);
    expect(result.findings.find((finding) => finding.marker === 'PAYMENT_CARD')?.confidence).toBe(1);
  });

  it('does not treat an invalid card-like number or a long random string as a secret', () => {
    const result = inspectGuardRequest({
      messages: [{ role: 'user', content: `ref ${invalidCard} token abcdefghijklmnopqrstuvwxyz123456` }],
    });
    expect(result.findings).toHaveLength(0);
  });

  it('detects bearer tokens, private keys and prefixed API keys', () => {
    const result = inspectGuardRequest({
      messages: [
        {
          role: 'user',
          content: 'Authorization: Bearer super-secret-token-value\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nsk-live-abcdefghijklmnop',
        },
      ],
    });
    expect(result.detectedSecrets).toEqual(expect.arrayContaining(['ACCESS_TOKEN', 'PRIVATE_KEY', 'API_KEY']));
    expect(JSON.stringify(result)).not.toContain('super-secret-token-value');
    expect(JSON.stringify(result)).not.toContain('sk-live');
  });

  it('redacts repeated text and leaves images and unrelated metadata intact', () => {
    const content = [
      { type: 'text', text: 'Please contact jane@example.com and jane@example.com' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/jane@example.com.png' } },
      { type: 'tool_result', payload: { keep: 'untouched jane@example.com' } },
    ];
    const redacted = redactGuardValue(content, new Set(['EMAIL']));
    const text = (redacted.value as Array<{ text?: string; image_url?: { url: string }; payload?: { keep: string } }>)[0];
    expect(text?.text).toBe('Please contact [REDACTED:EMAIL] and [REDACTED:EMAIL]');
    expect(redacted.counts.EMAIL).toBe(2);
    expect((redacted.value as Array<{ image_url?: { url: string } }>)[1]?.image_url?.url).toContain('jane@example.com');
    expect((redacted.value as Array<{ payload?: { keep: string } }>)[2]?.payload?.keep).toContain('jane@example.com');
    const plain = redactGuardText(`Hello ${validCard} world`, new Set(['PAYMENT_CARD']));
    expect(plain.text).toBe('Hello [REDACTED:PAYMENT_CARD] world');
    expect(plain.text).not.toContain(validCard);
  });
});

describe('guard enforcement timing', () => {
  it('keeps inspection and evaluation small for a short request', () => {
    const started = performance.now();
    inspectGuardRequest({ messages: [{ role: 'user', content: 'Please contact jane@example.com about order 100.' }] });
    const inspectionMs = performance.now() - started;
    const document: GuardPolicyDocument = {
      scope: { organizationWide: true },
      conditions: { logic: 'all', conditions: [{ field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' }] },
      actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
    };
    const policies: CompiledGuardPolicy[] = Array.from({ length: 25 }, (_, index) => ({
      organizationId: 'org',
      policyId: `policy-${index}`,
      policyVersionId: `version-${index}`,
      name: index === 0 ? 'Customer PII Protection' : `Other ${index}`,
      version: 1,
      priority: index === 0 ? 300 : 10,
      mode: 'enforce',
      document: index === 0 ? document : { ...document, conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'staging' }] } },
    }));
    evaluatePolicies({
      context: { organizationId: 'org', request: { detectedDataTypes: ['CUSTOMER_PII'] }, environment: 'production' },
      policies,
      organisationMode: 'protect',
      enforcementConnected: true,
    });
    const evalStarted = performance.now();
    const decision = evaluatePolicies({
      context: { organizationId: 'org', request: { detectedDataTypes: ['CUSTOMER_PII'] }, environment: 'production' },
      policies,
      organisationMode: 'protect',
      enforcementConnected: true,
    });
    const evaluationMs = performance.now() - evalStarted;
    const enforceStarted = performance.now();
    applyGuardEnforcement({
      decision,
      messages: [{ role: 'user', content: 'Please contact jane@example.com' }],
      findings: inspectGuardRequest({ messages: [{ role: 'user', content: 'Please contact jane@example.com' }] }).findings,
      dataTypes: ['CUSTOMER_PII'],
      failureMode: 'fail_open',
    });
    const enforcementMs = performance.now() - enforceStarted;
    expect(inspectionMs).toBeLessThan(30);
    expect(evaluationMs).toBeLessThan(20);
    expect(enforcementMs).toBeLessThan(30);
    expect(inspectionMs + evaluationMs + enforcementMs).toBeLessThan(50);
  });
});
