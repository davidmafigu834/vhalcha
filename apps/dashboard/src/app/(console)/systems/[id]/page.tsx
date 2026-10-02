import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission } from '@vhalcha/auth';
import { listAuditRecords } from '@vhalcha/database';
import { AccessDenied } from '../../../../components/access-denied';
import { KeyActions, RotateButton } from '../../../../components/forms';
import { RiskBadge } from '../../../../components/status';
import { usd, when } from '../../../../lib/format';
import { readIfAllowed } from '../../../../server/access';
import { getServices, repositories, requirePageAccess } from '../../../../server/services';
import { revokeVirtualKey, setSystemStatus } from '../../../../server/actions';

export const dynamic = 'force-dynamic';

const tabs = ['overview', 'usage', 'models', 'keys', 'requests', 'audit', 'settings'] as const;

export default async function SystemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const access = await requirePageAccess('ai_systems:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const { id } = await params;
  const tab = (await searchParams).tab ?? 'overview';
  const repos = repositories();
  const system = await repos.aiSystems.findById(session.claims.oid, id);
  if (!system) notFound();
  const environment = await repos.environments.findById(session.claims.oid, system.environmentId);
  const rules = await repos.modelAccess.listForSystem(session.claims.oid, id);
  const keys = await readIfAllowed(session.role, 'api_keys:read', () => repos.apiKeys.list(session.claims.oid, id));
  const requests = await readIfAllowed(session.role, 'gateway:read', async () =>
    (await repos.requests.list(session.claims.oid, new Date('2020-01-01T00:00:00Z'), new Date('2100-01-01T00:00:00Z'), 50)).filter(
      (request) => request.aiSystemId === id,
    ),
  );
  const auditRows = await readIfAllowed(session.role, 'audit:read', () =>
    listAuditRecords(getServices().db, session.claims.oid, { aiSystemId: id }),
  );
  const canWriteSystem = hasPermission(session.role, 'ai_systems:write');
  return (
    <>
      <div className="row-actions">
        <h1 className="page-title">{system.name}</h1>
        <RiskBadge level={system.riskLevel} />
        {canWriteSystem && system.status === 'active' ? (
          <form action={setSystemStatus.bind(null, id, 'disabled')}>
            <button className="critical" type="submit">
              Disable
            </button>
          </form>
        ) : null}
        {canWriteSystem && system.status !== 'active' ? (
          <form action={setSystemStatus.bind(null, id, 'active')}>
            <button type="submit">Enable</button>
          </form>
        ) : null}
      </div>
      <nav className="row-actions" aria-label="AI system sections">
        {tabs.map((item) => (
          <Link key={item} href={`/systems/${id}?tab=${item}`} aria-current={tab === item ? 'page' : undefined}>
            {item}
          </Link>
        ))}
      </nav>
      {tab === 'overview' ? (
        <section className="panel">
          <p>{system.description || 'No description.'}</p>
          <p>Environment: {environment?.name}</p>
          <p>Status: {system.status}</p>
          <p>Monthly budget: {usd(system.monthlyBudgetUsd ? Number(system.monthlyBudgetUsd) : null)}</p>
          <p>Rate limit: {system.requestsPerMinute}/min</p>
          <p>Last activity: <span className="mono">{when(system.lastActivityAt)}</span></p>
        </section>
      ) : null}
      {tab === 'usage' ? (
        <section className="panel">
          <p>{requests ? requests.length : 0} recent requests are stored for this system. Spend is calculated from usage events.</p>
        </section>
      ) : null}
      {tab === 'models' ? (
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Pattern</th>
                <th>Allowed</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.provider}</td>
                  <td className="mono">{rule.modelPattern}</td>
                  <td>{rule.isAllowed ? 'yes' : 'no'}</td>
                  <td>{rule.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {tab === 'keys' && !keys ? (
        <section className="panel">
          <p>API key metadata is not available for your role.</p>
        </section>
      ) : null}
      {tab === 'keys' && keys ? (
        <section className="panel">
          {hasPermission(session.role, 'api_keys:write') ? <KeyActions aiSystemId={id} /> : null}
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="mono">{key.keyPrefix}</td>
                  <td>{key.status}</td>
                  <td className="mono">{when(key.createdAt)}</td>
                  <td className="mono">{when(key.lastUsedAt)}</td>
                  <td className="row-actions">
                    {hasPermission(session.role, 'api_keys:write') && key.status === 'active' ? (
                      <>
                        <form action={revokeVirtualKey.bind(null, id, key.id)}>
                          <button className="secondary" type="submit">
                            Revoke
                          </button>
                        </form>
                        <RotateButton aiSystemId={id} keyId={key.id} />
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {tab === 'requests' && !requests ? (
        <section className="panel">
          <p>Gateway requests are not available for your role.</p>
        </section>
      ) : null}
      {tab === 'requests' && requests ? (
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Request ID</th>
                <th>Model</th>
                <th>Status</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td className="mono">{when(request.createdAt)}</td>
                  <td className="mono">{request.id}</td>
                  <td>{request.model}</td>
                  <td>{request.status}</td>
                  <td>{usd(request.estimatedCostUsd ? Number(request.estimatedCostUsd) : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {tab === 'audit' && !auditRows ? (
        <section className="panel">
          <p>Audit events are not available for your role.</p>
        </section>
      ) : null}
      {tab === 'audit' && auditRows ? (
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Action</th>
                <th>Result</th>
                <th>Severity</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((event) => (
                <tr key={event.id}>
                  <td className="mono">{when(event.createdAt)}</td>
                  <td>{event.action}</td>
                  <td>{event.result}</td>
                  <td>{event.severity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {tab === 'settings' ? (
        <section className="panel">
          <p>Type: {system.type}</p>
          <p>Slug: <span className="mono">{system.slug}</span></p>
          <p>Requests per minute: {system.requestsPerMinute}</p>
        </section>
      ) : null}
    </>
  );
}
