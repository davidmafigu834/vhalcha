import { getOverviewReport } from '@vhalcha/database';
import { calculatePolicyCompliance } from '@vhalcha/policies';
import { HealthStatus, PolicyStatus } from '../../../components/status';
import { AccessDenied } from '../../../components/access-denied';
import { usd } from '../../../lib/format';
import { getServices, requirePageAccess } from '../../../server/services';

export const metadata = { title: 'Overview' };

async function gatewayState(baseUrl: string): Promise<'Healthy' | 'Degraded' | 'Offline'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const [health, ready] = await Promise.all([
      fetch(new URL('/health', baseUrl), { signal: controller.signal, cache: 'no-store' }),
      fetch(new URL('/ready', baseUrl), { signal: controller.signal, cache: 'no-store' }),
    ]);
    if (health.ok && ready.ok) return 'Healthy';
    if (health.ok) return 'Degraded';
    return 'Offline';
  } catch {
    return 'Offline';
  } finally {
    clearTimeout(timer);
  }
}

export default async function OverviewPage() {
  const access = await requirePageAccess('overview:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const report = await getOverviewReport(getServices().db, session.claims.oid);
  const compliance = calculatePolicyCompliance({
    allowedRequests: report.succeeded30d,
    blockedRequests: report.blocked30d,
    warningEvents: report.warningEvents30d,
    systemsRequiringAttention: report.needsAction.length,
    totalSystems: report.systemCount,
  });
  const health = await gatewayState(getServices().config.VHALCHA_GATEWAY_URL);
  const maxSpend = Math.max(...report.daily.map((day) => day.spend), 0);
  return (
    <>
      <h1 className="page-title">Overview</h1>
      <section className="grid-4">
        <article className="metric">
          <span>AI Systems</span>
          <strong>{report.systemCount}</strong>
        </article>
        <article className="metric">
          <span>AI Spend · 30d</span>
          <strong>{usd(report.spend30d)}</strong>
        </article>
        <article className="metric">
          <span>Policy Compliance</span>
          <strong>{compliance.score === null ? '—' : `${Math.round(compliance.score * 100)}%`}</strong>
          <PolicyStatus result={compliance.label} />
        </article>
        <article className="metric">
          <span>Needs Action</span>
          <strong>{report.needsAction.length}</strong>
        </article>
      </section>
      <section className="grid-2">
        <article className="panel">
          <h2>Spend & Requests</h2>
          <p className="muted">{report.requestCount30d} requests in the last 30 days.</p>
          {report.daily.length === 0 ? (
            <p className="empty">No usage in the last 14 days.</p>
          ) : (
            <ul>
              {report.daily.map((day) => (
                <li key={day.day}>
                  <span className="mono">{day.day}</span> {usd(day.spend)} · {day.requests} usage events
                  <div className="bar" aria-hidden="true">
                    <span style={{ width: `${maxSpend === 0 ? 0 : (day.spend / maxSpend) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
        <article className="panel">
          <h2>Systems Requiring Attention</h2>
          {report.needsAction.length === 0 ? (
            <p className="empty">No systems are marked attention or offline.</p>
          ) : (
            <ul>
              {report.needsAction.map((system) => (
                <li key={system.id}>
                  <a href={`/systems/${system.id}`}>{system.name}</a> · {system.status}
                </li>
              ))}
            </ul>
          )}
        </article>
        <article className="panel">
          <h2>Recent Policy Events</h2>
          {report.recentPolicyEvents.length === 0 ? (
            <p className="empty">No policy events recorded.</p>
          ) : (
            <ul>
              {report.recentPolicyEvents.map((event) => (
                <li key={event.id}>
                  <PolicyStatus result={event.result} /> {event.policyName}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">{compliance.explanation}</p>
        </article>
        <article className="panel">
          <h2>Gateway Health</h2>
          <HealthStatus state={health} />
          <p className="muted">The dashboard reads gateway health. Gateway traffic does not depend on this page.</p>
        </article>
      </section>
    </>
  );
}
