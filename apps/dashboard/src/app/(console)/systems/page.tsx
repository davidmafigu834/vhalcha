import Link from 'next/link';
import { hasPermission } from '@vhalcha/auth';
import { listSystemRows } from '@vhalcha/database';
import { AccessDenied } from '../../../components/access-denied';
import { RiskBadge } from '../../../components/status';
import { usd, when } from '../../../lib/format';
import { getServices, requirePageAccess } from '../../../server/services';

export const metadata = { title: 'AI Systems' };

export default async function SystemsPage() {
  const access = await requirePageAccess('ai_systems:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const rows = await listSystemRows(getServices().db, session.claims.oid);
  return (
    <>
      <div className="row-actions">
        <h1 className="page-title">AI Systems</h1>
        {hasPermission(session.role, 'ai_systems:write') ? (
          <Link className="button" href="/systems/new">
            Register AI system
          </Link>
        ) : null}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Environment</th>
              <th>Provider</th>
              <th>Spend 30d</th>
              <th>Requests 30d</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9}>No AI systems registered.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/systems/${row.id}`}>{row.name}</Link>
                  </td>
                  <td>{row.type}</td>
                  <td>{row.environmentName}</td>
                  <td>{row.provider || '—'}</td>
                  <td>{usd(row.spend30d)}</td>
                  <td>{row.requests30d}</td>
                  <td>{row.status}</td>
                  <td>
                    <RiskBadge level={row.riskLevel} />
                  </td>
                  <td className="mono">{when(row.lastActivityAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
