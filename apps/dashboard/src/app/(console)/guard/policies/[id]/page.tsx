import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission } from '@vhalcha/auth';
import { getGuardPolicy, getGuardSettings, listGuardPolicyReferences } from '@vhalcha/database';
import { describeEffectiveBehaviour, guardActionRuntimeSupport, primaryAction, type GuardMode } from '@vhalcha/guard';
import { AccessDenied } from '../../../../../components/access-denied';
import { GuardPage } from '../../../../../components/guard-ui';
import { when } from '../../../../../lib/format';
import { activateGuardPolicyAction, deleteGuardPolicyAction, disableGuardPolicyAction } from '../../../../../server/guard-actions';
import { getServices, repositories, requirePageAccess } from '../../../../../server/services';

export const metadata = { title: 'Guard policy' };

export default async function GuardPolicyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const { id } = await params;
  const notice = (await searchParams).notice;
  const services = getServices();
  const detail = await getGuardPolicy(services.db, access.claims.oid, id);
  if (!detail) notFound();
  const [settings, references, users] = await Promise.all([
    getGuardSettings(services.db, access.claims.oid),
    listGuardPolicyReferences(services.db, access.claims.oid),
    repositories().users.list(access.claims.oid),
  ]);
  const names = new Map(references.systems.map((system) => [system.id, system.name]));
  const action = primaryAction(detail.policy.document.actions);
  const creator = users.find((user) => user.id === detail.policy.createdBy)?.name ?? 'Operator';
  const canEdit = hasPermission(access.role, 'guard:policy:edit');
  const canActivate = hasPermission(access.role, 'guard:policy:activate');
  return (
    <GuardPage
      title={detail.policy.name}
      lead={detail.policy.description || 'Organisational policy decision.'}
      actions={
        <>
          {canEdit ? (
            <Link className="button secondary" href={`/guard/policies/${detail.policy.id}/edit`}>
              Edit
            </Link>
          ) : null}
          {canEdit ? (
            <Link className="button" href={`/guard/policies/${detail.policy.id}/test`}>
              Test policy
            </Link>
          ) : null}
        </>
      }
    >
      {notice ? <p className={notice === 'saved' || notice === 'activated' || notice === 'disabled' ? 'ok' : 'error'}>{notice}</p> : null}
      <section className="panel">
        <p>
          Status <strong>{detail.policy.status.toUpperCase()}</strong> · Mode {detail.policy.mode.toUpperCase()} · Priority {detail.policy.priority}
        </p>
        <p>
          Category {detail.policy.category} · Current version v{detail.policy.currentVersion} · Created by {creator} · Updated {when(detail.policy.updatedAt)}
        </p>
        <p>Vhalcha Gateway can block, redact, warn, monitor and allow when Protect is active. Approval, route and incident actions are not executed.</p>
        <div className="button-row">
          {canActivate && detail.policy.status !== 'active' ? (
            <form action={activateGuardPolicyAction}>
              <input type="hidden" name="policyId" value={detail.policy.id} />
              <button type="submit">Activate</button>
            </form>
          ) : null}
          {canActivate && detail.policy.status !== 'disabled' ? (
            <form action={disableGuardPolicyAction}>
              <input type="hidden" name="policyId" value={detail.policy.id} />
              <button className="secondary" type="submit">
                Disable
              </button>
            </form>
          ) : null}
          {canEdit && detail.policy.status === 'draft' ? (
            <form action={deleteGuardPolicyAction}>
              <input type="hidden" name="policyId" value={detail.policy.id} />
              <button className="critical" type="submit">
                Delete draft
              </button>
            </form>
          ) : null}
        </div>
      </section>
      <section className="panel">
        <h2>Scope</h2>
        <p>
          {detail.policy.document.scope.organizationWide
            ? 'Entire organisation'
            : (detail.policy.document.scope.systemIds ?? []).map((systemId) => names.get(systemId) ?? 'Selected AI system').join(', ') || 'No AI system limit'}
        </p>
        <p className="muted">
          Environments {(detail.policy.document.scope.environments ?? []).join(', ') || 'any'} · Providers {(detail.policy.document.scope.providers ?? []).join(', ') || 'any'} · Models{' '}
          {(detail.policy.document.scope.models ?? []).join(', ') || 'any'}
        </p>
      </section>
      <section className="panel">
        <h2>Conditions</h2>
        <pre className="policy-json">{JSON.stringify(detail.policy.document.conditions, null, 2)}</pre>
      </section>
      <section className="panel">
        <h2>Action</h2>
        <p>
          <strong>{action.type.replaceAll('_', ' ')}</strong>
        </p>
        <p>Runtime support: {guardActionRuntimeSupport(action.type)}</p>
        <p>Current organisation mode: {settings.mode.toUpperCase()}</p>
        <p>
          Current effective behaviour:{' '}
          {services.config.GUARD_PROTECT_MODE_ENABLED && settings.mode === 'protect' && detail.policy.mode === 'enforce' && ['block', 'redact', 'warn', 'monitor', 'allow'].includes(action.type)
            ? action.type.toUpperCase()
            : ['block', 'redact', 'require_approval', 'route'].includes(action.type)
              ? `WOULD ${action.type.replaceAll('_', ' ').toUpperCase()}`
              : action.type.toUpperCase()}
        </p>
      </section>
      <section className="panel">
        <h2>Plain-English behaviour</h2>
        <p>{detail.policy.summary}</p>
        <p>Current organisation mode: {settings.mode.toUpperCase()}</p>
        <p>
          {describeEffectiveBehaviour({
            action: action.type,
            policyMode: detail.policy.mode,
            organisationMode: settings.mode as GuardMode,
            enforcementConnected: services.config.GUARD_PROTECT_MODE_ENABLED,
          })}
        </p>
        <p className="muted">Existing model access rules still apply separately and are not overridden by this policy.</p>
      </section>
      <section className="panel">
        <h2>Recent decisions</h2>
        {detail.decisions.length === 0 ? (
          <p>
            No policy evaluations yet. Live gateway requests are inspected when Guard is enabled. You can also test this policy using the policy tester.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th>Decision</th>
                  <th>Would enforce</th>
                </tr>
              </thead>
              <tbody>
                {detail.decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td>
                      <Link href={`/guard/policies/decisions/${decision.id}`}>{when(decision.evaluatedAt)}</Link>
                    </td>
                    <td>{decision.source}</td>
                    <td>{decision.decision}</td>
                    <td>{decision.wouldEnforceAction ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Version history</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Summary</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map((version) => (
                <tr key={version.id}>
                  <td>v{version.version}</td>
                  <td>{version.summary}</td>
                  <td>{when(version.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Audit history</h2>
        {detail.audits.length === 0 ? (
          <p className="muted">No policy audit events yet.</p>
        ) : (
          <ul>
            {detail.audits.map((event) => (
              <li key={event.id}>
                {event.action} · {when(event.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </GuardPage>
  );
}
