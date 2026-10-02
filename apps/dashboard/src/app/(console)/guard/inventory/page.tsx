import Link from 'next/link';
import { listGuardInventory, guardInventoryTab } from '@vhalcha/database';
import { guardStatuses, type GuardStatus } from '@vhalcha/guard';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage, runtimeLabel, StatusText } from '../../../../components/guard-ui';
import { RiskBadge } from '../../../../components/status';
import { when } from '../../../../lib/format';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'AI Inventory' };

const tabs = [
  ['all', 'All'],
  ['applications', 'Applications'],
  ['agents', 'Agents'],
  ['models', 'Models'],
  ['providers', 'Providers'],
  ['unknown', 'Unknown'],
] as const;

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; status?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const params = await searchParams;
  const tab = tabs.some(([id]) => id === params.tab) ? params.tab ?? 'all' : 'all';
  const status = guardStatuses.find((item) => item === params.status);
  const inventory = await listGuardInventory(getServices().db, access.claims.oid);
  const systems = inventory.systems.filter((system) => {
    if (!guardInventoryTab(system, tab === 'models' || tab === 'providers' ? 'all' : tab)) return false;
    if (status && system.guardStatus !== status) return false;
    return true;
  });
  return (
    <GuardPage
      title="AI Inventory"
      lead="Discover and monitor AI applications, agents, models and integrations across your organisation."
    >
      <nav className="tabs" aria-label="Inventory">
        {tabs.map(([id, label]) => (
          <Link key={id} href={id === 'all' ? '/guard/inventory' : `/guard/inventory?tab=${id}`} aria-current={tab === id ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {status ? (
        <p className="muted">
          Filtered to {status} systems. <Link href="/guard/inventory">Clear</Link>
        </p>
      ) : null}
      {tab === 'models' ? (
        inventory.models.length === 0 ? (
          <p className="empty">No model access rules are stored for this organisation.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model pattern</th>
                  <th>Allowed</th>
                  <th>Systems</th>
                </tr>
              </thead>
              <tbody>
                {inventory.models.map((model) => (
                  <tr key={`${model.provider}:${model.model}`}>
                    <td>{model.provider}</td>
                    <td className="mono">{model.model}</td>
                    <td>{model.allowed ? 'Allowed' : 'Blocked'}</td>
                    <td>{model.systems.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {tab === 'providers' ? (
        inventory.providers.length === 0 ? (
          <p className="empty">No providers are connected or referenced by model rules.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>AI systems</th>
                  <th>Connection</th>
                </tr>
              </thead>
              <tbody>
                {inventory.providers.map((provider) => (
                  <tr key={provider.provider}>
                    <td>{provider.provider}</td>
                    <td>{provider.systems}</td>
                    <td>{provider.connectionStatus ?? 'No connection record'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {tab !== 'models' && tab !== 'providers' ? (
        systems.length === 0 ? (
          <p className="empty">No AI systems match this view. Register a system before Guard can monitor it.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>System</th>
                  <th>Type</th>
                  <th>Owner</th>
                  <th>Provider</th>
                  <th>Models</th>
                  <th>Data access</th>
                  <th>Runtime</th>
                  <th>Guard status</th>
                  <th>Risk</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {systems.map((system) => (
                  <tr key={system.id}>
                    <td>
                      <Link href={`/guard/inventory/${system.id}`}>{system.name}</Link>
                    </td>
                    <td>{system.type}</td>
                    <td>{system.ownerName ?? 'Unassigned'}</td>
                    <td>{system.provider ?? '—'}</td>
                    <td>{system.models.join(', ') || '—'}</td>
                    <td>{system.dataAccess.join(', ') || 'Not declared'}</td>
                    <td>{runtimeLabel(system.runtime)}</td>
                    <td>
                      <StatusText status={system.guardStatus as GuardStatus} />
                    </td>
                    <td>
                      <RiskBadge level={system.riskLevel} />
                    </td>
                    <td className="mono">{when(system.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </GuardPage>
  );
}
