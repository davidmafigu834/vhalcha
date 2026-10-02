import { listAuditRecords } from '@vhalcha/database';
import { AccessDenied } from '../../../components/access-denied';
import { when } from '../../../lib/format';
import { getServices, repositories, requirePageAccess } from '../../../server/services';

export const metadata = { title: 'Audit log' };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await requirePageAccess('audit:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const params = await searchParams;
  const systems = await repositories().aiSystems.list(session.claims.oid);
  const rows = await listAuditRecords(getServices().db, session.claims.oid, {
    start: params.from ? new Date(params.from) : undefined,
    end: params.to ? new Date(params.to) : undefined,
    actorType: params.actorType,
    action: params.action,
    severity: params.severity,
    result: params.result,
    aiSystemId: params.aiSystemId,
  });
  return (
    <>
      <h1 className="page-title">Audit log</h1>
      <p className="muted">Audit records are append-only and cannot be edited here.</p>
      <form className="filters" action="/audit" method="get">
        <label>From<input type="date" name="from" defaultValue={params.from} /></label>
        <label>To<input type="date" name="to" defaultValue={params.to} /></label>
        <label>Actor type
          <select name="actorType" defaultValue={params.actorType ?? ''}>
            <option value="">Any</option>
            {['user', 'ai_system', 'api', 'system'].map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label>Action<input name="action" defaultValue={params.action ?? ''} /></label>
        <label>Severity
          <select name="severity" defaultValue={params.severity ?? ''}>
            <option value="">Any</option>
            {['info', 'warning', 'critical'].map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label>Result
          <select name="result" defaultValue={params.result ?? ''}>
            <option value="">Any</option>
            {['success', 'failure', 'blocked'].map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label>AI system
          <select name="aiSystemId" defaultValue={params.aiSystemId ?? ''}>
            <option value="">Any</option>
            {systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
          </select>
        </label>
        <button className="secondary" type="submit">Filter</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Result</th>
              <th>Severity</th>
              <th>Request ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={7}>No audit events match these filters.</td></tr> : rows.map((row) => (
              <tr key={row.id}>
                <td className="mono">{when(row.createdAt)}</td>
                <td>{row.actorType}{row.actorId ? ` · ${row.actorId.slice(0, 8)}` : ''}</td>
                <td>{row.action}</td>
                <td>{row.resourceType}</td>
                <td>{row.result}</td>
                <td>{row.severity}</td>
                <td className="mono">{row.requestId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
