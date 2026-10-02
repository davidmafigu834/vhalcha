import Link from 'next/link';
import { getGuardDataSecurity, listGuardEvents } from '@vhalcha/database';
import { guardClassificationLabel, resolveGuardRange } from '@vhalcha/guard';
import { AccessDenied } from '../../../../components/access-denied';
import { EventRows, GuardPage } from '../../../../components/guard-ui';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Data security' };

function percent(part: number, total: number) {
  if (total <= 0) return null;
  return Math.round((part / total) * 100);
}

export default async function DataSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const range = resolveGuardRange((await searchParams).range);
  const services = getServices();
  const report = await getGuardDataSecurity(services.db, access.claims.oid, range);
  const events = await listGuardEvents(services.db, access.claims.oid, {
    start: range.start,
    end: range.end,
    types: ['sensitive_data'],
    limit: 50,
  });
  const classes = new Map<string, { total: number; redacted: number; observed: number; blocked: number }>();
  for (const row of report.byClassification) {
    const key = row.classification || 'unspecified';
    const current = classes.get(key) ?? { total: 0, redacted: 0, observed: 0, blocked: 0 };
    const total = Number(row.total);
    current.total += total;
    if (row.outcome === 'redacted') current.redacted += total;
    else if (row.outcome === 'blocked') current.blocked += total;
    else current.observed += total;
    classes.set(key, current);
  }
  return (
    <GuardPage title="Data Security" lead="Understand sensitive information detected in AI requests and how Guard handled it.">
      <form className="filters" action="/guard/data-security" method="get">
        <label>
          Time
          <select name="range" defaultValue={range.key}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
        <button className="secondary" type="submit">Apply</button>
      </form>
      <p className="muted">Live gateway events only. Policy tests and simulations are excluded. Sensitive evidence is intentionally masked. Detection is limited to email, NANP-style phone numbers, Luhn-valid payment cards, and known secret patterns.</p>
      {report.sensitiveEvents === 0 ? (
        <section className="panel">
          <h2>No sensitive data detected</h2>
          <p>Guard has not detected supported sensitive-data types in live AI requests during this period.</p>
        </section>
      ) : (
        <>
          <section className="guard-metrics" aria-label="Data security metrics">
            <span><span>Sensitive-data events</span><strong>{report.sensitiveEvents}</strong></span>
            <span><span>Requests containing sensitive data</span><strong>{report.sensitiveRequests}</strong></span>
            <span><span>Values redacted</span><strong>{report.valuesRedacted}</strong></span>
            <span><span>Requests blocked</span><strong>{report.blockedRequests}</strong></span>
            <span><span>Systems involved</span><strong>{report.systems}</strong></span>
          </section>
          <section className="panel">
            <h2>By classification</h2>
            <ul>
              {[...classes.entries()].map(([classification, counts]) => {
                const redacted = percent(counts.redacted, counts.total);
                const observed = percent(counts.observed, counts.total);
                const blocked = percent(counts.blocked, counts.total);
                return (
                  <li key={classification}>
                    {classification.split(',').map(guardClassificationLabel).join(', ')} — {counts.total} detections
                    {redacted === null ? '' : ` · ${redacted}% redacted · ${observed}% observed · ${blocked}% blocked`}
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="grid-2">
            <article className="panel">
              <h2>By AI system</h2>
              <ul>{report.bySystem.map((row) => <li key={row.aiSystemId ?? 'none'}>{row.name} — {row.total}</li>)}</ul>
            </article>
            <article className="panel">
              <h2>By provider and model</h2>
              <ul>{report.byProvider.map((row) => <li key={`${row.provider}-${row.model}`}>{row.provider ?? 'Unknown provider'} / {row.model ?? 'unknown model'} — {row.total}</li>)}</ul>
            </article>
            <article className="panel">
              <h2>By environment</h2>
              <ul>{report.byEnvironment.map((row) => <li key={row.environmentId ?? 'none'}>{row.name} — {row.total}</li>)}</ul>
            </article>
            <article className="panel">
              <h2>By policy</h2>
              <ul>
                {report.byPolicy.map((row) => (
                  <li key={`${row.policyId}-${row.policyVersion}`}>
                    {row.policyId ? <Link href={`/guard/policies/${row.policyId}`}>{row.policyName} v{row.policyVersion}</Link> : 'No policy'} — {row.total}
                  </li>
                ))}
              </ul>
            </article>
          </section>
          <section className="panel">
            <h2>Data flow</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>AI system</th><th>Detected data</th><th>Destination</th><th>Policy</th><th>Outcome</th><th>Events</th></tr>
                </thead>
                <tbody>
                  {report.flow.map((row) => (
                    <tr key={`${row.aiSystemId}-${row.provider}-${row.model}-${row.policyId}-${row.classification}-${row.outcome}`}>
                      <td>{row.systemName}</td>
                      <td>{row.classification ? row.classification.split(',').map(guardClassificationLabel).join(', ') : '—'}</td>
                      <td>{row.provider ?? '—'} / {row.model ?? '—'}</td>
                      <td>{row.policyName ? `${row.policyName}${row.policyVersion ? ` v${row.policyVersion}` : ''}` : '—'}</td>
                      <td>{(row.outcome || 'recorded').replaceAll('_', ' ').toUpperCase()}</td>
                      <td>{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      <section className="panel">
        <h2>Sensitive data events</h2>
        <EventRows events={events} hrefFor={(id) => `/guard?event=${id}&range=${range.key}`} />
      </section>
    </GuardPage>
  );
}
