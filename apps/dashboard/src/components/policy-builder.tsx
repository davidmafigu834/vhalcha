'use client';

import { useMemo, useState } from 'react';
import {
  GUARD_POLICY_PRIORITY_DEFAULT,
  describeEffectiveBehaviour,
  guardActionRuntimeSupport,
  guardEnvironments,
  guardPolicyActionTypes,
  guardPolicyCategories,
  guardPolicyFieldRegistry,
  guardPolicyFields,
  operationalGuardActions,
  summarizePolicyDocument,
  type GuardConditionGroup,
  type GuardEnvironmentName,
  type GuardMode,
  type GuardPolicyActionType,
  type GuardPolicyCategory,
  type GuardPolicyCondition,
  type GuardPolicyDocument,
  type GuardPolicyField,
  type GuardPolicyMode,
} from '@vhalcha/guard';
import { saveGuardPolicy } from '../server/guard-actions';

const builderActions = guardPolicyActionTypes.filter(
  (action) => action !== 'log' && action !== 'create_incident',
);

export interface PolicyBuilderInitial {
  policyId?: string;
  name: string;
  description: string;
  category: GuardPolicyCategory;
  priority: number;
  mode: GuardPolicyMode;
  document: GuardPolicyDocument;
}

export interface PolicyBuilderReferences {
  systems: Array<{ id: string; name: string }>;
  providers: string[];
  models: Array<{ id: string; provider: string; displayName: string }>;
  organisationMode: GuardMode;
  protectCapability: boolean;
}

const steps = ['Basics', 'Scope', 'Conditions', 'Action', 'Mode', 'Review'] as const;

function isGroup(value: GuardPolicyCondition | GuardConditionGroup): value is GuardConditionGroup {
  return 'logic' in value;
}

export function PolicyBuilder({
  initial,
  references,
}: {
  initial: PolicyBuilderInitial;
  references: PolicyBuilderReferences;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [category, setCategory] = useState(initial.category);
  const [priority, setPriority] = useState(initial.priority);
  const [mode, setMode] = useState(initial.mode);
  const [organizationWide, setOrganizationWide] = useState(Boolean(initial.document.scope.organizationWide));
  const [systemIds, setSystemIds] = useState(initial.document.scope.systemIds ?? []);
  const [environments, setEnvironments] = useState<GuardEnvironmentName[]>(initial.document.scope.environments ?? []);
  const [providers, setProviders] = useState(initial.document.scope.providers ?? []);
  const [models, setModels] = useState(initial.document.scope.models ?? []);
  const [extraProvider, setExtraProvider] = useState('');
  const [systemQuery, setSystemQuery] = useState('');
  const [conditions, setConditions] = useState<GuardConditionGroup>(initial.document.conditions);
  const primary = initial.document.actions[0];
  const [actionType, setActionType] = useState<GuardPolicyActionType>(primary?.type ?? 'monitor');
  const [dataTypes, setDataTypes] = useState(primary?.config?.dataTypes?.join(', ') ?? '');
  const [routeProviderId, setRouteProviderId] = useState(primary?.config?.routeProviderId ?? '');
  const [routeModelId, setRouteModelId] = useState(primary?.config?.routeModelId ?? '');
  const [approvalGroup, setApprovalGroup] = useState(primary?.config?.approvalGroup ?? '');
  const [message, setMessage] = useState(primary?.config?.message ?? '');

  const document = useMemo<GuardPolicyDocument>(() => {
    const config: NonNullable<GuardPolicyDocument['actions'][number]['config']> = {};
    const types = dataTypes
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (types.length > 0) config.dataTypes = types;
    if (routeProviderId.trim()) config.routeProviderId = routeProviderId.trim();
    if (routeModelId.trim()) config.routeModelId = routeModelId.trim();
    if (approvalGroup.trim()) config.approvalGroup = approvalGroup.trim();
    if (message.trim()) config.message = message.trim();
    return {
      scope: {
        organizationWide: organizationWide || undefined,
        systemIds: organizationWide ? undefined : systemIds,
        environments: environments.length > 0 ? environments : undefined,
        providers: providers.length > 0 ? providers : undefined,
        models: models.length > 0 ? models : undefined,
      },
      conditions,
      actions: [{ type: actionType, config: Object.keys(config).length > 0 ? config : undefined }],
    };
  }, [
    actionType,
    approvalGroup,
    conditions,
    dataTypes,
    environments,
    message,
    models,
    organizationWide,
    providers,
    routeModelId,
    routeProviderId,
    systemIds,
  ]);

  const names = new Map(references.systems.map((system) => [system.id, system.name]));
  const summary = summarizePolicyDocument(name || 'Untitled policy', document, names);
  const behaviour = describeEffectiveBehaviour({
    action: actionType,
    policyMode: mode,
    organisationMode: references.organisationMode,
    enforcementConnected: references.protectCapability,
  });
  const runtimeSupport = guardActionRuntimeSupport(actionType);
  const scopeSummary = [
    organizationWide ? 'Entire organisation' : systemIds.length > 0 ? `${systemIds.length} AI systems` : null,
    environments.length > 0 ? environments.join(', ') : null,
    providers.length > 0 ? `${providers.length} providers` : null,
    models.length > 0 ? `${models.length} models` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <form action={saveGuardPolicy} className="policy-builder">
      {initial.policyId ? <input type="hidden" name="policyId" value={initial.policyId} /> : null}
      <input type="hidden" name="payload" value={JSON.stringify({ name, description, category, priority, mode, document })} />
      <ol className="policy-steps">
        {steps.map((label, index) => (
          <li key={label}>
            <button type="button" className={index === step ? 'secondary' : 'secondary'} aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}>
              {index + 1}. {label}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <section className="panel">
          <h2>Basics</h2>
          <label>
            Policy name
            <input value={name} onChange={(event) => setName(event.target.value)} required minLength={3} maxLength={120} />
          </label>
          <label>
            Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={3} />
          </label>
          <label>
            Category
            <select value={category} onChange={(event) => setCategory(event.target.value as GuardPolicyCategory)}>
              {guardPolicyCategories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <input type="number" min={1} max={1000} value={priority} onChange={(event) => setPriority(Number(event.target.value))} />
          </label>
          <p className="muted">Higher priority is evaluated first. The default is {GUARD_POLICY_PRIORITY_DEFAULT}. Range 1–1000.</p>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="panel">
          <h2>Scope</h2>
          <label className="check">
            <input type="checkbox" checked={organizationWide} onChange={(event) => setOrganizationWide(event.target.checked)} />
            Entire organisation
          </label>
          {organizationWide ? null : (
            <>
              <label>
                Search AI systems
                <input value={systemQuery} onChange={(event) => setSystemQuery(event.target.value)} placeholder="System name" />
              </label>
              <div className="choice-list">
                {references.systems
                  .filter((system) => system.name.toLowerCase().includes(systemQuery.toLowerCase()))
                  .map((system) => (
                    <label key={system.id} className="check">
                      <input
                        type="checkbox"
                        checked={systemIds.includes(system.id)}
                        onChange={(event) =>
                          setSystemIds((current) =>
                            event.target.checked ? [...current, system.id] : current.filter((id) => id !== system.id),
                          )
                        }
                      />
                      {system.name}
                    </label>
                  ))}
              </div>
            </>
          )}
          <fieldset>
            <legend>Environment</legend>
            {guardEnvironments.map((environment) => (
              <label key={environment} className="check">
                <input
                  type="checkbox"
                  checked={environments.includes(environment)}
                  onChange={(event) =>
                    setEnvironments((current) =>
                      event.target.checked ? [...current, environment] : current.filter((item) => item !== environment),
                    )
                  }
                />
                {environment}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Provider</legend>
            {references.providers.map((provider) => (
              <label key={provider} className="check">
                <input
                  type="checkbox"
                  checked={providers.includes(provider)}
                  onChange={(event) =>
                    setProviders((current) => (event.target.checked ? [...current, provider] : current.filter((item) => item !== provider)))
                  }
                />
                {provider}
              </label>
            ))}
            <label>
              Additional provider id
              <input value={extraProvider} onChange={(event) => setExtraProvider(event.target.value)} placeholder="stable provider id" />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const next = extraProvider.trim();
                if (!next || providers.includes(next)) return;
                setProviders((current) => [...current, next]);
                setExtraProvider('');
              }}
            >
              Add provider id
            </button>
          </fieldset>
          <fieldset>
            <legend>Model</legend>
            <div className="choice-list">
              {references.models.map((model) => (
                <label key={model.id} className="check">
                  <input
                    type="checkbox"
                    checked={models.includes(model.id)}
                    onChange={(event) =>
                      setModels((current) => (event.target.checked ? [...current, model.id] : current.filter((item) => item !== model.id)))
                    }
                  />
                  {model.displayName} <span className="muted">{model.provider}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p>
            Applies to: <strong>{scopeSummary || 'Choose a scope'}</strong>
          </p>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="panel">
          <h2>Conditions</h2>
          <p className="muted">WHEN the group matches. Groups can be nested three levels deep. Values are identifiers such as CUSTOMER_PII, not free text prompts.</p>
          <ConditionEditor group={conditions} depth={1} onChange={setConditions} />
        </section>
      ) : null}

      {step === 3 ? (
        <section className="panel">
          <h2>Action</h2>
          <div className="action-grid">
            {builderActions.map((action) => {
              const live = operationalGuardActions.includes(action as (typeof operationalGuardActions)[number]);
              return (
                <label key={action} className={actionType === action ? 'action-card action-card-selected' : 'action-card'}>
                  <input type="radio" name="actionChoice" checked={actionType === action} onChange={() => setActionType(action)} />
                  <strong>{action.replaceAll('_', ' ')}</strong>
                  <span>{live ? 'Decision supported. Operational in monitor records.' : 'Available for policy decisions. Live gateway enforcement arrives in Guard Protect.'}</span>
                </label>
              );
            })}
          </div>
          {actionType === 'redact' ? (
            <label>
              Data types
              <input value={dataTypes} onChange={(event) => setDataTypes(event.target.value)} placeholder="CUSTOMER_PII" />
            </label>
          ) : null}
          {actionType === 'route' ? (
            <>
              <label>
                Destination provider id
                <input value={routeProviderId} onChange={(event) => setRouteProviderId(event.target.value)} required />
              </label>
              <label>
                Destination model id
                <input value={routeModelId} onChange={(event) => setRouteModelId(event.target.value)} />
              </label>
            </>
          ) : null}
          {actionType === 'require_approval' ? (
            <label>
              Approval group
              <input value={approvalGroup} onChange={(event) => setApprovalGroup(event.target.value)} placeholder="security-admin" />
            </label>
          ) : null}
          {actionType === 'warn' || actionType === 'block' ? (
            <label>
              Message
              <input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={240} />
            </label>
          ) : null}
        </section>
      ) : null}

      {step === 4 ? (
        <section className="panel">
          <h2>Mode</h2>
          <label className="check">
            <input type="radio" checked={mode === 'monitor'} onChange={() => setMode('monitor')} />
            Monitor — record when the policy matches without taking the configured enforcement action.
          </label>
          <label className="check">
            <input type="radio" checked={mode === 'enforce'} onChange={() => setMode('enforce')} />
            Enforce — prepare the configured enforcement action when Guard Protect is active.
          </label>
          <p className="muted">
            Vhalcha Gateway can block or redact when this organisation is in Protect and Protect is enabled for the deployment. Monitor records the match and leaves the request unchanged.
          </p>
        </section>
      ) : null}

      {step === 5 ? (
        <section className="panel">
          <h2>Review</h2>
          <p>{summary}</p>
          <p>Configured action: {actionType.replaceAll('_', ' ').toUpperCase()}</p>
          <p>Runtime support: {runtimeSupport}</p>
          <p>Current organisation mode: {references.organisationMode.toUpperCase()}</p>
          <p>{behaviour}</p>
          <p className="muted">Saving creates a draft. Activation is a separate step. Guard does not choose the provider.</p>
          <button type="submit">{initial.policyId ? 'Save new version' : 'Save draft'}</button>
        </section>
      ) : null}

      <div className="button-row">
        {step > 0 ? (
          <button type="button" className="secondary" onClick={() => setStep((current) => current - 1)}>
            Back
          </button>
        ) : null}
        {step < steps.length - 1 ? (
          <button type="button" onClick={() => setStep((current) => current + 1)}>
            Continue
          </button>
        ) : null}
      </div>
    </form>
  );
}

function ConditionEditor({
  group,
  depth,
  onChange,
}: {
  group: GuardConditionGroup;
  depth: number;
  onChange: (next: GuardConditionGroup) => void;
}) {
  function update(index: number, next: GuardPolicyCondition | GuardConditionGroup) {
    onChange({ ...group, conditions: group.conditions.map((entry, entryIndex) => (entryIndex === index ? next : entry)) });
  }
  return (
    <div className="condition-group">
      <label>
        Match
        <select value={group.logic} onChange={(event) => onChange({ ...group, logic: event.target.value === 'any' ? 'any' : 'all' })}>
          <option value="all">ALL</option>
          <option value="any">ANY</option>
        </select>
      </label>
      {group.conditions.map((entry, index) =>
        isGroup(entry) ? (
          <ConditionEditor key={index} group={entry} depth={depth + 1} onChange={(next) => update(index, next)} />
        ) : (
          <ConditionRow key={index} condition={entry} onChange={(next) => update(index, next)} onRemove={() => onChange({ ...group, conditions: group.conditions.filter((_, entryIndex) => entryIndex !== index) })} />
        ),
      )}
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          onClick={() =>
            onChange({
              ...group,
              conditions: [...group.conditions, { field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' }],
            })
          }
        >
          Add condition
        </button>
        {depth < 3 ? (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              onChange({
                ...group,
                conditions: [
                  ...group.conditions,
                  { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
                ],
              })
            }
          >
            Add group
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: GuardPolicyCondition;
  onChange: (next: GuardPolicyCondition) => void;
  onRemove: () => void;
}) {
  const spec = guardPolicyFieldRegistry[condition.field];
  const value = Array.isArray(condition.value) ? condition.value.join(', ') : condition.value ?? '';
  return (
    <div className="rule-row">
      <select
        value={condition.field}
        onChange={(event) => {
          const field = event.target.value as GuardPolicyField;
          const next = guardPolicyFieldRegistry[field];
          onChange({ field, operator: next.operators[0] ?? 'equals', value: next.valueType === 'number' ? 0 : '' });
        }}
      >
        {guardPolicyFields.map((field) => (
          <option key={field} value={field}>
            {guardPolicyFieldRegistry[field].label}
          </option>
        ))}
      </select>
      <select
        value={condition.operator}
        onChange={(event) => onChange({ ...condition, operator: event.target.value as GuardPolicyCondition['operator'] })}
      >
        {spec.operators.map((operator) => (
          <option key={operator} value={operator}>
            {operator.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
      {condition.operator === 'exists' || condition.operator === 'not_exists' ? null : spec.valueType === 'number' ? (
        <input
          type="number"
          value={typeof value === 'number' ? value : Number(value) || 0}
          onChange={(event) => onChange({ ...condition, value: Number(event.target.value) })}
        />
      ) : (
        <input
          value={String(value)}
          onChange={(event) => {
            const text = event.target.value;
            onChange({
              ...condition,
              value: condition.operator === 'in' || condition.operator === 'not_in' ? text.split(',').map((item) => item.trim()).filter(Boolean) : text,
            });
          }}
        />
      )}
      <button type="button" className="secondary" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}
