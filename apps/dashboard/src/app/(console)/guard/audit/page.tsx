import { listGuardAudit } from '@vhalcha/database';
import { auditActions } from '@vhalcha/audit';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage } from '../../../../components/guard-ui';
import { when } from '../../../../lib/format';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Guard audit' };

const actions = [auditActions.guardSettingsUpdated, auditActions.guardProfileUpdated, auditActions.guardEventExpected];

export default async function GuardAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const access = await requirePageAccess('guard:audit:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const params = await searchParams;
  const action = actions.find((item) => item === params.action);
  const rows = await listGuardAudit(getServices().db, access.claims.oid, { action });
  return (
    <GuardPage title="Audit" lead="Append-only Guard actions. Prompt content and secrets are not stored in these records.">
      <form className="filters" action="/guard/audit" method="get">
        <label>
          Action
          <select name="action" defaultValue={action ?? ''}>
            <option value="">Any Guard action</option>
            {actions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary" type="submit">
          Filter
        </button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Result</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>No Guard audit records match this filter.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{when(row.createdAt)}</td>
                  <td>
                    {row.actorType}
                    {row.actorId ? ` · ${row.actorId.slice(0, 8)}` : ''}
                  </td>
                  <td>{row.action}</td>
                  <td>
                    {row.resourceType}
                    {row.resourceId ? ` · ${row.resourceId.slice(0, 8)}` : ''}
                  </td>
                  <td>{row.result}</td>
                  <td>Guard</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </GuardPage>
  );
}
