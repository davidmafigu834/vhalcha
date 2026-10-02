import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission } from '@vhalcha/auth';
import { getGuardSystemDetail } from '@vhalcha/database';
import { guardRuntimes, guardStatuses } from '@vhalcha/guard';
import { AccessDenied } from '../../../../../components/access-denied';
import { actionLabel, EventRows, GuardPage, runtimeLabel, StatusText } from '../../../../../components/guard-ui';
import { RiskBadge } from '../../../../../components/status';
import { when } from '../../../../../lib/format';
import { saveGuardProfile } from '../../../../../server/guard-actions';
import { getServices, requirePageAccess } from '../../../../../server/services';

export const metadata = { title: 'AI system' };

const tabs = ['overview', 'activity', 'permissions', 'policies', 'data', 'models', 'incidents', 'audit'] as const;

export default async function GuardSystemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; notice?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const { id } = await params;
  const query = await searchParams;
  const tab = tabs.find((item) => item === query.tab) ?? 'overview';
  const detail = await getGuardSystemDetail(getServices().db, access.claims.oid, id);
  if (!detail) notFound();
  const { system } = detail;
  const canConfigure = hasPermission(access.role, 'guard:configure');
  return (
    <GuardPage title={system.name} lead={system.description || 'Registered AI system.'}>
      <p>
        <StatusText status={system.guardStatus} /> <RiskBadge level={system.riskLevel} />
      </p>
      {query.notice === 'saved' ? <p className="ok">Guard profile saved. The change is in the audit log.</p> : null}
      {query.notice === 'invalid' ? <p className="error">The Guard profile could not be saved.</p> : null}
      <nav className="tabs" aria-label="System">
        {tabs.map((item) => (
          <Link key={item} href={`/guard/inventory/${id}?tab=${item}`} aria-current={tab === item ? 'page' : undefined}>
            {item}
          </Link>
        ))}
      </nav>
      {tab === 'overview' ? (
        <section className="grid-2">
          <article className="panel">
            <h2>Overview</h2>
            <p>Owner: {system.ownerName ?? 'Unassigned'}</p>
            <p>Environment: {system.environmentName} ({system.environmentType})</p>
            <p>Runtime: {runtimeLabel(system.runtime)}</p>
            <p>Provider: {system.provider ?? 'Not observed'}</p>
            <p>Models: {system.models.join(', ') || 'No model access rules'}</p>
            <p>Data sources: {system.dataAccess.join(', ') || 'Not declared'}</p>
            <p>Last active: <span className="mono">{when(system.lastActivityAt)}</span></p>
          </article>
          <article className="panel">
            <h2>Last 30 days</h2>
            <p>Requests: {detail.metrics.requests30d}</p>
            <p>Blocked by the gateway: {detail.metrics.gatewayBlocked30d}</p>
            <p>Guard violations: {detail.metrics.violations}</p>
            <p>Blocked by Guard: {detail.metrics.guardBlocked}</p>
            <p>Sensitive-data events: {detail.metrics.sensitiveDataEvents}</p>
            <p className="muted">Open incidents are not linked to individual systems yet.</p>
            <h2>Effective policies</h2>
            <p>No Guard policies are assigned. Inherited organisation and team policies are not evaluated in this release.</p>
          </article>
        </section>
      ) : null}
      {tab === 'activity' ? (
        <section className="panel">
          <h2>Activity</h2>
          <EventRows events={detail.events} hrefFor={(eventId) => `/guard?event=${eventId}`} />
        </section>
      ) : null}
      {tab === 'permissions' ? (
        <section className="panel">
          <h2>Permissions</h2>
          <p>Agent permissions are not configured. Guard does not infer allow, deny, or approval from the system type.</p>
          <p>{system.overprivileged ? 'This system is marked overprivileged in its Guard profile.' : 'This system is not marked overprivileged.'}</p>
          <Link href="/guard/permissions">Open permissions</Link>
        </section>
      ) : null}
      {tab === 'policies' ? (
        <section className="panel">
          <h2>Policies</h2>
          <p>No Guard policy applies to this system yet.</p>
          <h2>Existing model access rules</h2>
          {detail.rules.length === 0 ? (
            <p className="empty">No model access rules.</p>
          ) : (
            <ul>
              {detail.rules.map((rule) => (
                <li key={rule.id}>
                  {rule.provider} · <span className="mono">{rule.modelPattern}</span> · {rule.isAllowed ? 'allowed' : 'blocked'}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">These rules are the existing control-plane model policy. They are not Guard policy versions.</p>
        </section>
      ) : null}
      {tab === 'data' ? (
        <section className="panel">
          <h2>Data</h2>
          {system.dataAccess.length === 0 ? <p>No data sources are declared for this system.</p> : (
            <ul>
              {system.dataAccess.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ul>
          )}
          <p>
            Sensitive-data access: {system.sensitiveDataUnrestricted ? 'marked unrestricted' : 'not marked unrestricted'}
          </p>
        </section>
      ) : null}
      {tab === 'models' ? (
        <section className="panel">
          <h2>Models</h2>
          {system.models.length === 0 ? <p className="empty">No model patterns are stored.</p> : <p>{system.models.join(', ')}</p>}
        </section>
      ) : null}
      {tab === 'incidents' ? (
        <section className="panel">
          <h2>Incidents</h2>
          <p className="empty">No incidents are linked to this system.</p>
        </section>
      ) : null}
      {tab === 'audit' ? (
        <section className="panel">
          <h2>Audit</h2>
          {detail.audit.length === 0 ? (
            <p className="empty">No Guard audit records for this system.</p>
          ) : (
            <ul>
              {detail.audit.map((event) => (
                <li key={event.id}>
                  <span className="mono">{when(event.createdAt)}</span> {event.action} · {event.result}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {canConfigure ? (
        <section className="panel">
          <h2>Guard profile</h2>
          <form action={saveGuardProfile} className="filters">
            <input type="hidden" name="aiSystemId" value={system.id} />
            <label>
              Guard status
              <select name="guardStatus" defaultValue={system.guardStatus === 'protected' ? 'monitored' : system.guardStatus}>
                {guardStatuses.filter((item) => item !== 'protected').map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Runtime
              <select name="runtime" defaultValue={system.runtime}>
                {guardRuntimes.map((item) => (
                  <option key={item} value={item}>
                    {runtimeLabel(item)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Data access labels
              <input name="dataAccess" defaultValue={system.dataAccess.join(', ')} />
            </label>
            <label>
              <span>Unrestricted sensitive data</span>
              <input type="checkbox" name="sensitiveDataUnrestricted" defaultChecked={system.sensitiveDataUnrestricted} />
            </label>
            <label>
              <span>Overprivileged</span>
              <input type="checkbox" name="overprivileged" defaultChecked={system.overprivileged} />
            </label>
            <button type="submit">Save profile</button>
          </form>
          <p className="muted">Saving records an audit event. It does not block traffic. Protected is unavailable until Guard enforces requests on the gateway.</p>
        </section>
      ) : null}
      {detail.events.length > 0 && tab === 'overview' ? (
        <section className="panel">
          <h2>Recent Guard events</h2>
          <ul>
            {detail.events.slice(0, 5).map((event) => (
              <li key={event.id}>
                {actionLabel(event.actionTaken)} · {event.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </GuardPage>
  );
}
