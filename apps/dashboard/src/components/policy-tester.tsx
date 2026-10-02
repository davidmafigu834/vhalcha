'use client';

import { useState } from 'react';
import { guardEnvironments } from '@vhalcha/guard';
import { testGuardPolicy } from '../server/guard-actions';

export function PolicyTester({
  policyId,
  systems,
  providers,
  models,
}: {
  policyId?: string;
  systems: Array<{ id: string; name: string }>;
  providers: string[];
  models: Array<{ id: string; displayName: string; provider: string }>;
}) {
  const [providerId, setProviderId] = useState(providers[0] ?? '');
  const [customProvider, setCustomProvider] = useState('');
  return (
    <form action={testGuardPolicy} className="panel policy-tester">
      {policyId ? <input type="hidden" name="policyId" value={policyId} /> : null}
      <h2>Test policy</h2>
      <p className="muted">This runs the real policy engine against a synthetic context. It does not modify a live request.</p>
      <label>
        AI system
        <select name="systemId" defaultValue={systems[0]?.id ?? ''}>
          <option value="">None</option>
          {systems.map((system) => (
            <option key={system.id} value={system.id}>
              {system.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Environment
        <select name="environment" defaultValue="production">
          {guardEnvironments.map((environment) => (
            <option key={environment} value={environment}>
              {environment}
            </option>
          ))}
        </select>
      </label>
      <label>
        Provider
        <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
          <option value="">Custom id</option>
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
      </label>
      <label>
        Provider id
        <input
          name="providerId"
          value={providerId || customProvider}
          onChange={(event) => {
            setProviderId('');
            setCustomProvider(event.target.value);
          }}
        />
      </label>
      <label>
        Model
        <select name="modelId" defaultValue="">
          <option value="">None</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName} ({model.provider})
            </option>
          ))}
        </select>
      </label>
      <label>
        Detected data
        <input name="detectedData" placeholder="CUSTOMER_PII" />
      </label>
      <label>
        Prompt risk flags
        <input name="promptRiskFlags" placeholder="none" />
      </label>
      <label>
        Tool name
        <input name="toolName" />
      </label>
      <label>
        Tool risk
        <input name="toolRisk" placeholder="high" />
      </label>
      <fieldset>
        <legend>Evaluation set</legend>
        <label className="check">
          <input type="radio" name="evaluationSet" value="policy" defaultChecked={Boolean(policyId)} disabled={!policyId} />
          Test this policy only
        </label>
        <label className="check">
          <input type="radio" name="evaluationSet" value="all" defaultChecked={!policyId} />
          Evaluate against all active policies
        </label>
      </fieldset>
      <button type="submit">Evaluate</button>
    </form>
  );
}
