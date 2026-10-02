import Link from 'next/link';
import { listGuardThreats } from '@vhalcha/database';
import {
  formatGuardSequence,
  guardThreatStatuses,
  guardThreatTypeLabels,
  guardThreatTypes,
  resolveGuardRange,
  type GuardThreatSeverity,
  type GuardThreatStatus,
  type GuardThreatType,
} from '@vhalcha/guard';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage, SeverityMark } from '../../../../components/guard-ui';
import { when } from '../../../../lib/format';
import { getServices, repositories, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Threat Center' };

const severities: GuardThreatSeverity[] = ['critical', 'high', 'medium', 'low'];
const outcomes = ['blocked', 'redacted', 'would_enforce', 'failed_open', 'failed_closed', 'continued'];

function query(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `/guard/threats?${text}` : '/guard/threats';
}

export default async function ThreatsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const params = await searchParams;
  const range = resolveGuardRange(params.range);
  const severity = severities.find((item) => item === params.severity);
  const status = guardThreatStatuses.find((item) => item === params.status);
  const type = guardThreatTypes.find((item) => item === params.type && item !== 'prompt_risk' && item !== 'suspicious_tool_action');
  const systems = await repositories().aiSystems.list(access.claims.oid);
  const environments = await repositories().environments.list(access.claims.oid);
  const systemId = systems.some((system) => system.id === params.system) ? params.system : undefined;
  const environmentId = environments.some((environment) => environment.id === params.environment) ? params.environment : undefined;
  const page = Number(params.page) || 1;
  const listed = await listGuardThreats(getServices().db, access.claims.oid, {
    start: range.start,
    end: range.end,
    severity,
    status: status as GuardThreatStatus | undefined,
    type: type as GuardThreatType | undefined,
    aiSystemId: systemId,
    environmentId,
    provider: params.provider || undefined,
    model: params.model || undefined,
    outcome: outcomes.find((item) => item === params.outcome),
    search: params.q,
    page,
  });
  const open = await listGuardThreats(getServices().db, access.claims.oid, { status: 'open' });
  const high = await listGuardThreats(getServices().db, access.claims.oid, { severity: 'high', status: 'open' });
  const critical = await listGuardThreats(getServices().db, access.claims.oid, { severity: 'critical', status: 'open' });
  const blocked = await listGuardThreats(getServices().db, access.claims.oid, { outcome: 'blocked', start: range.start, end: range.end });
  const sensitive = await listGuardThreats(getServices().db, access.claims.oid, { type: 'sensitive_data_exposure', start: range.start, end: range.end });
  const runtime = await listGuardThreats(getServices().db, access.claims.oid, { type: 'runtime_enforcement_failure', start: range.start, end: range.end });
  const preserved = {
    range: range.key,
    severity,
    status,
    type,
    system: systemId,
    environment: environmentId,
    provider: params.provider,
    model: params.model,
    outcome: params.outcome,
    q: params.q,
  };
  return (
    <GuardPage
      title="Threat Center"
      lead="Investigate security risks detected across your organisation's AI systems."
    >
      <p className="muted">Sensitive evidence is intentionally masked. Counts come from Guard threat records, not a sample feed.</p>
      <section className="guard-metrics" aria-label="Threat summary">
        <Link href={query({ status: 'open' })}><span>Open threats</span><strong>{open.total}</strong></Link>
        <Link href={query({ severity: 'high', status: 'open' })}><span>High / Critical</span><strong>{high.total + critical.total}</strong></Link>
        <Link href={query({ ...preserved, outcome: 'blocked' })}><span>Blocked</span><strong>{blocked.total}</strong></Link>
        <Link href={query({ ...preserved, type: 'sensitive_data_exposure' })}><span>Sensitive-data threats</span><strong>{sensitive.total}</strong></Link>
        <Link href={query({ ...preserved, type: 'runtime_enforcement_failure' })}><span>Runtime issues</span><strong>{runtime.total}</strong></Link>
      </section>
      <form className="filters" action="/guard/threats" method="get">
        <label>Time<select name="range" defaultValue={range.key}><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
        <label>Severity<select name="severity" defaultValue={severity ?? ''}><option value="">Any</option>{severities.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
        <label>Status<select name="status" defaultValue={status ?? ''}><option value="">Any</option>{guardThreatStatuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Threat type<select name="type" defaultValue={type ?? ''}><option value="">Any</option>{guardThreatTypes.filter((item) => item !== 'prompt_risk' && item !== 'suspicious_tool_action').map((item) => <option key={item} value={item}>{guardThreatTypeLabels[item]}</option>)}</select></label>
        <label>AI system<select name="system" defaultValue={systemId ?? ''}><option value="">Any</option>{systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}</select></label>
        <label>Environment<select name="environment" defaultValue={environmentId ?? ''}><option value="">Any</option>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label>
        <label>Provider<input name="provider" defaultValue={params.provider ?? ''} /></label>
        <label>Model<input name="model" defaultValue={params.model ?? ''} /></label>
        <label>Outcome<select name="outcome" defaultValue={params.outcome ?? ''}><option value="">Any</option>{outcomes.map((item) => <option key={item} value={item}>{item.replaceAll('_', ' ')}</option>)}</select></label>
        <label>Search<input name="q" defaultValue={params.q ?? ''} placeholder="Threat ID, request ID, system, policy" /></label>
        <button className="secondary" type="submit">Filter</button>
      </form>
      {listed.rows.length === 0 ? (
        <section className="panel">
          <h2>No security threats detected</h2>
          <p>Guard has not classified any live security events as threats for the selected period.</p>
        </section>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Threat</th>
                <th>AI system</th>
                <th>Policy</th>
                <th>Outcome</th>
                <th>Occurrences</th>
                <th>Status</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {listed.rows.map((threat) => (
                <tr key={threat.id}>
                  <td><SeverityMark severity={threat.severity} /></td>
                  <td><Link href={`/guard/threats/${threat.id}`}>{formatGuardSequence('THR', threat.displayNumber)}</Link><div>{threat.title}</div></td>
                  <td>{threat.systemName ?? 'Unknown system'}</td>
                  <td>{threat.policyId ? <Link href={`/guard/policies/${threat.policyId}`}>{threat.policyName}{threat.policyVersion ? ` v${threat.policyVersion}` : ''}</Link> : '—'}</td>
                  <td>{(threat.outcome || 'recorded').replaceAll('_', ' ').toUpperCase()}</td>
                  <td>{threat.occurrenceCount}</td>
                  <td>{threat.status}</td>
                  <td className="mono">{when(threat.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {listed.total > listed.pageSize ? (
        <p className="button-row">
          {page > 1 ? <Link href={query({ ...preserved, page: String(page - 1) })}>Previous</Link> : null}
          <span className="muted">Page {page}</span>
          {page * listed.pageSize < listed.total ? <Link href={query({ ...preserved, page: String(page + 1) })}>Next</Link> : null}
        </p>
      ) : null}
    </GuardPage>
  );
}
