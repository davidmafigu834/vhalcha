import Link from 'next/link';
import { hasPermission } from '@vhalcha/auth';
import { findGuardIncidentForEvent, findGuardThreatForEvent, getGuardEvent, getGuardOverview, getGuardSecurityAttention, listGuardEvents } from '@vhalcha/database';
import {
  guardEventTypes,
  guardSeverities,
  resolveGuardRange,
  type PostureFinding,
} from '@vhalcha/guard';
import { AccessDenied } from '../../../components/access-denied';
import { EventDrawer, EventRows, GuardPage, ModeBadge } from '../../../components/guard-ui';
import { createGuardIncidentAction, markExpectedGuardEvent } from '../../../server/guard-actions';
import { getServices, requirePageAccess } from '../../../server/services';

export const metadata = { title: 'Guard' };

const findingLinks: Record<PostureFinding['id'], string> = {
  unprotectedSystems: '/guard/inventory?status=unprotected',
  unresolvedHighIncidents: '/guard/incidents',
  criticalPolicyViolations: '/guard?type=policy_violation&severity=critical',
  unrestrictedSensitiveData: '/guard/data-security',
  missingAuditLogging: '/guard/settings',
  overprivilegedAgents: '/guard/permissions',
  unknownSystems: '/guard/inventory?tab=unknown',
  disabledEnforcement: '/guard/settings',
};

function query(range: string, extra: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams({ range });
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  return `/guard?${params.toString()}`;
}

export default async function GuardOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; event?: string; type?: string; severity?: string; notice?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const params = await searchParams;
  const range = resolveGuardRange(params.range);
  const services = getServices();
  const overview = await getGuardOverview(services.db, session.claims.oid, range, {
    deploymentGuardEnabled: services.config.GUARD_ENABLED,
  });
  const type = guardEventTypes.find((item) => item === params.type);
  const severity = guardSeverities.find((item) => item === params.severity);
  const activity =
    type || severity
      ? await listGuardEvents(services.db, session.claims.oid, {
          start: range.start,
          end: range.end,
          types: type ? [type] : undefined,
          severity,
          limit: 50,
        })
      : overview.events;
  const selected = params.event ? await getGuardEvent(services.db, session.claims.oid, params.event) : null;
  const attention = await getGuardSecurityAttention(services.db, session.claims.oid, range);
  const threatLink = selected ? await findGuardThreatForEvent(services.db, session.claims.oid, selected.id) : null;
  const incidentLink = selected ? await findGuardIncidentForEvent(services.db, session.claims.oid, selected.id) : null;
  const metrics = [
    ['AI Systems', overview.metrics.aiSystems, '/guard/inventory'],
    ['Protected Systems', overview.metrics.protectedSystems, '/guard/inventory?status=protected'],
    ['Requests Inspected', overview.metrics.requestsInspected, query(range.key)],
    ['Policy Violations', overview.metrics.policyViolations, query(range.key, { type: 'policy_violation' })],
    ['Threats Detected', overview.metrics.threatsDetected, `/guard/threats?range=${range.key}`],
    ['Blocked Requests', overview.metrics.blockedRequests, query(range.key, { type: 'blocked_request' })],
    ['Sensitive Data Events', overview.metrics.sensitiveDataEvents, `/guard/data-security?range=${range.key}`],
    ['Open Incidents', overview.metrics.openIncidents, '/guard/incidents'],
  ] as const;
  const coveragePercent =
    overview.coverage.total === 0 ? null : Math.round((overview.coverage.covered / overview.coverage.total) * 100);
  return (
    <GuardPage
      title="Guard"
      lead="Control how AI systems access data, tools and models across your organisation."
      actions={
        <>
          <form action="/guard" method="get">
            <label>
              <span className="muted">Range</span>
              <select name="range" defaultValue={range.key}>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </select>
            </label>
            <button className="secondary" type="submit">
              Apply
            </button>
          </form>
          <Link className="button secondary" href="/guard/settings">
            Configure Guard
          </Link>
          <ModeBadge mode={overview.settings.mode} />
        </>
      }
    >
      {overview.settings.organisationLabel === 'demo' ? (
        <p className="guard-banner">Demonstration organisation. Figures come from stored configuration and recorded events.</p>
      ) : null}
      {!services.config.GUARD_ENABLED ? (
        <p className="guard-banner">Guard is disabled for this deployment. Requests are not inspected.</p>
      ) : (
        <p className="muted">Monitor records what Guard would do. Protect can block or redact supported requests after this organisation chooses it.</p>
      )}
      <section className="guard-hero">
        <article className="guard-posture">
          <p className="muted">AI security posture</p>
          <p className="guard-score">{overview.posture.score === null ? '—' : overview.posture.score}</p>
          <p>{overview.posture.status === 'unscored' ? 'NOT SCORED' : overview.posture.status.toUpperCase()}</p>
          <p className="muted">
            {overview.posture.score === null
              ? 'Register an AI system before Guard can score this organisation.'
              : `${overview.posture.findings.length} issue${overview.posture.findings.length === 1 ? '' : 's'} require attention`}
          </p>
        </article>
        <article className="panel">
          <h2>Findings</h2>
          {overview.posture.findings.length === 0 ? (
            <p className="empty">
              {overview.posture.score === null
                ? 'No AI systems are registered, so there is nothing to score.'
                : 'No measured findings. The score is 100 because none of the posture rules matched stored configuration or open events.'}
            </p>
          ) : (
            <ul>
              {overview.posture.findings.map((finding) => (
                <li key={finding.id}>
                  <Link href={findingLinks[finding.id]}>{finding.summary}</Link>
                  <span className="muted"> · −{finding.penalty}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
      <section className="panel">
        <h2>Requires attention</h2>
        {attention.highThreats === 0 && attention.staleInvestigations === 0 && attention.sensitiveEvents === 0 && attention.runtimeErrors === 0 ? (
          <p className="empty">No open high-severity threats, stale investigations, sensitive-data events, or runtime enforcement failures in this view.</p>
        ) : (
          <ul>
            {attention.highThreats > 0 ? <li>{attention.highThreats} high or critical threats remain active</li> : null}
            {attention.staleInvestigations > 0 ? <li>{attention.staleInvestigations} incident{attention.staleInvestigations === 1 ? ' has' : 's have'} been investigating for more than 3 days</li> : null}
            {attention.sensitiveEvents > 0 ? <li>{attention.sensitiveEvents} sensitive-data events in {range.label.toLowerCase()}</li> : null}
            {attention.runtimeErrors > 0 ? <li>{attention.runtimeErrors} Guard runtime enforcement failure{attention.runtimeErrors === 1 ? '' : 's'} occurred</li> : null}
          </ul>
        )}
        <p className="muted">
          Active threats {attention.openThreats}. Open incidents {attention.openIncidents}. Blocked {attention.blockedRequests}. Redacted {attention.redactedRequests}.
        </p>
      </section>
      <section className="guard-metrics" aria-label="Guard metrics">
        {metrics.map(([label, value, href]) => (
          <Link key={label} href={href}>
            <span>{label}</span>
            <strong>{value}</strong>
          </Link>
        ))}
      </section>
      <section className="panel">
        <h2>Live security activity</h2>
        <p className="muted">{range.label}. Times are UTC. Inspection counts only requests that produced a Guard event.</p>
        <EventRows events={activity} hrefFor={(id) => query(range.key, { event: id, type, severity })} />
      </section>
      <section className="grid-2">
        <article className="panel">
          <h2>Highest-risk AI systems</h2>
          {attention.systems.length === 0 ? (
            <p className="empty">No threat activity is stored for a registered system.</p>
          ) : (
            <ul>
              {attention.systems.map((system) => (
                <li key={system.id}>
                  <Link href={`/guard/inventory/${system.id}`}>{system.name}</Link>
                  <div className="muted">
                    {system.highThreats} high or critical threats · {system.sensitive} sensitive-data threats
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
        <article className="panel">
          <h2>Guard coverage</h2>
          <p>
            {overview.coverage.covered} of {overview.coverage.total} systems are monitored or protected.
            {coveragePercent === null ? '' : ` ${coveragePercent}% coverage.`}
          </p>
          <p className="muted">
            This counts explicit Guard profiles. It is not a policy evaluation, and it does not mean requests are blocked.
          </p>
          <Link href="/guard/inventory">Review inventory</Link>
        </article>
      </section>
      {selected ? (
        <EventDrawer
          event={selected}
          closeHref={query(range.key, { type, severity })}
          canMarkExpected={hasPermission(session.role, 'guard:configure')}
          markAction={markExpectedGuardEvent}
          returnTo={query(range.key, { type, severity })}
          threat={threatLink}
          incident={incidentLink}
          canManage={hasPermission(session.role, 'guard:incident:manage')}
          createIncident={createGuardIncidentAction}
        />
      ) : null}
      {params.event && !selected ? <p className="error">That event is not in this organisation.</p> : null}
    </GuardPage>
  );
}
