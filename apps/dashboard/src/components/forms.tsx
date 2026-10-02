'use client';

import { useState } from 'react';
import {
  createVirtualKey,
  registerSystem,
  requestPasswordReset,
  resetPassword,
  rotateVirtualKey,
  signIn,
  updateBudget,
} from '../server/actions';
import { KeyReveal } from './status';

export function SignInForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (formData) => {
        const result = await signIn(formData);
        if (result?.error) setError(result.error);
      }}
    >
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit">Sign in</button>
    </form>
  );
}

export function ResetRequestForm() {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      action={async (formData) => {
        const result = await requestPasswordReset(formData);
        setMessage(result.message);
      }}
    >
      <label>
        Email
        <input name="email" type="email" required />
      </label>
      {message ? <p>{message}</p> : null}
      <button type="submit">Send reset link</button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (formData) => {
        const result = await resetPassword(formData);
        if (result?.error) setError(result.error);
      }}
    >
      <input type="hidden" name="token" value={token} />
      <label>
        New password
        <input name="password" type="password" minLength={12} required />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit">Update password</button>
    </form>
  );
}

export function RegisterForm({
  environments,
  devModel,
}: {
  environments: Array<{ id: string; name: string; type: string }>;
  devModel: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ systemId: string; rawKey: string | null } | null>(null);
  if (created?.rawKey) {
    return <KeyReveal rawKey={created.rawKey} continueHref={`/systems/${created.systemId}?tab=keys`} />;
  }
  if (created) {
    return (
      <p>
        AI system registered. <a href={`/systems/${created.systemId}`}>Open it</a>
      </p>
    );
  }
  return (
    <form
      className="grid-2"
      action={async (formData) => {
        const result = await registerSystem(formData);
        if ('error' in result && result.error) setError(result.error);
        else if ('systemId' in result && result.systemId) {
          setCreated({ systemId: result.systemId, rawKey: result.rawKey ?? null });
        }
      }}
    >
      <label>
        Name
        <input name="name" required />
      </label>
      <label>
        Type
        <select name="type" defaultValue="assistant">
          {['application', 'agent', 'workflow', 'assistant', 'service'].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
      <label>
        Environment
        <select name="environmentId" required>
          {environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name} ({environment.type})
            </option>
          ))}
        </select>
      </label>
      <label>
        Risk level
        <select name="riskLevel" defaultValue="medium">
          {['low', 'medium', 'high', 'critical'].map((level) => (
            <option key={level}>{level}</option>
          ))}
        </select>
      </label>
      <label>
        Monthly budget (USD)
        <input name="monthlyBudgetUsd" type="number" min="0" step="0.01" defaultValue="25" required />
      </label>
      <label>
        Allowed OpenAI model pattern
        <input name="modelPattern" defaultValue={devModel} required />
      </label>
      <label>
        Rate limit (requests per minute)
        <input name="requestsPerMinute" type="number" min="1" defaultValue="60" required />
      </label>
      <label>
        Description
        <textarea name="description" />
      </label>
      <label>
        <span>Generate virtual key</span>
        <input name="generateKey" type="checkbox" defaultChecked />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit">Register AI system</button>
    </form>
  );
}

export function KeyActions({ aiSystemId }: { aiSystemId: string }) {
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rawKey) {
    return <KeyReveal rawKey={rawKey} continueHref={`/systems/${aiSystemId}?tab=keys`} />;
  }
  return (
    <div className="button-row">
      <button
        type="button"
        onClick={async () => {
          const result = await createVirtualKey(aiSystemId);
          if (result.error) setError(result.error);
          if (result.rawKey) setRawKey(result.rawKey);
        }}
      >
        Generate key
      </button>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export function RotateButton({ aiSystemId, keyId }: { aiSystemId: string; keyId: string }) {
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rawKey) return <KeyReveal rawKey={rawKey} continueHref={`/systems/${aiSystemId}?tab=keys`} />;
  return (
    <button
      className="secondary"
      type="button"
      onClick={async () => {
        const result = await rotateVirtualKey(aiSystemId, keyId);
        if (result?.error) setError(result.error);
        if (result?.rawKey) setRawKey(result.rawKey);
      }}
    >
      Rotate
      {error ? <span className="error"> {error}</span> : null}
    </button>
  );
}

export function BudgetForm({
  budgetId,
  amount,
  threshold,
  action,
}: {
  budgetId: string;
  amount: string;
  threshold: number;
  action: string;
}) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="inline-form"
      action={async (formData) => {
        const result = await updateBudget(formData);
        setMessage(result.error ?? 'Budget saved.');
      }}
    >
      <input type="hidden" name="budgetId" value={budgetId} />
      <label>
        Amount USD
        <input name="amountUsd" type="number" min="0" step="0.01" defaultValue={amount} />
      </label>
      <label>
        Warning %
        <input name="warningThresholdPercent" type="number" min="1" max="100" defaultValue={threshold} />
      </label>
      <label>
        Action
        <select name="action" defaultValue={action}>
          <option value="block">block</option>
          <option value="notify">notify</option>
        </select>
      </label>
      <button type="submit">Save budget</button>
      {message ? <p>{message}</p> : null}
    </form>
  );
}
