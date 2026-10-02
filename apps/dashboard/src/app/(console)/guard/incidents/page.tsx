import Link from 'next/link';
import { listGuardIncidentCases } from '@vhalcha/database';
import { resolveGuardRange } from '@vhalcha/guard';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage, SeverityMark } from '../../../../components/guard-ui';
import { when } from '../../../../lib/format';
import { getServices, repositories, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Incidents' };

const statuses = ['open', 'investigating', 'contained', 'resolved', 'dismissed'];
const severities = ['critical', 'high', 'medium', 'low'];

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const params = await searchParams;
  const range = resolveGuardRange(params.range);
  const systems = await repositories().aiSystems.list(access.claims.oid);
  const systemId = systems.some((system) => system.id === params.system) ? params.system : undefined;
  const listed = await listGuardIncidentCases(getServices().db, access.claims.oid, {
    status: statuses.find((item) => item === params.status),
    severity: severities.find((item) => item === params.severity),
    ownerUserId: params.owner || undefined,
    aiSystemId: systemId,
    start: params.range ? range.start : undefined,
    end: params.range ? range.end : undefined,
    page: Number(params.page) || 1,
  });
  return (
    <GuardPage title="Incidents" lead="A security case humans decided requires investigation and resolution. Guard does not open an incident for every threat.">
      <form className="filters" action="/guard/incidents" method="get">
        <label>Status<select name="status" defaultValue={params.status ?? ''}><option value="">Any</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Severity<select name="severity" defaultValue={params.severity ?? ''}><option value="">Any</option>{severities.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
        <label>AI system<select name="system" defaultValue={systemId ?? ''}><option value="">Any</option>{systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}</select></label>
        <label>Time<select name="range" defaultValue={params.range ?? ''}><option value="">Any time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
        <button className="secondary" type="submit">Filter</button>
      </form>
      {listed.rows.length === 0 ? (
        <section className="panel">
          <h2>No security incidents</h2>
          <p>Create an incident when a Guard threat or event requires human investigation.</p>
        </section>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Incident</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Affected systems</th>
                <th>Related threats</th>
                <th>Owner</th>
                <th>Created</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {listed.rows.map((incident) => (
                <tr key={incident.id}>
                  <td><Link href={`/guard/incidents/${incident.id}`}>{incident.label}</Link><div>{incident.title}</div></td>
                  <td><SeverityMark severity={incident.severity} /></td>
                  <td>{incident.status}</td>
                  <td>{incident.systems.join(', ') || '—'}</td>
                  <td>{incident.threatCount}</td>
                  <td>{incident.ownerName}</td>
                  <td className="mono">{when(incident.createdAt)}</td>
                  <td className="mono">{when(incident.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GuardPage>
  );
}
