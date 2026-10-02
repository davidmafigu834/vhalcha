import { listGuardInventory } from '@vhalcha/database';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage } from '../../../../components/guard-ui';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Permissions' };

export default async function PermissionsPage() {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const inventory = await listGuardInventory(getServices().db, access.claims.oid);
  const flagged = inventory.systems.filter((system) => system.overprivileged);
  return (
    <GuardPage
      title="Permissions"
      lead="Agent capability grants are not stored yet. Guard will not infer allow, deny, or approval from a system name."
    >
      <section className="panel">
        <h2>No permission grants</h2>
        <p>Permissions will be recorded as agent, capability, resource, decision and constraints. None are stored.</p>
        <p className="muted">An agent cannot approve its own escalation. That control is not active because approval requests are not stored.</p>
      </section>
      <section className="panel">
        <h2>Profiles marked overprivileged</h2>
        {flagged.length === 0 ? (
          <p className="empty">No AI system is marked overprivileged.</p>
        ) : (
          <ul>
            {flagged.map((system) => (
              <li key={system.id}>{system.name}</li>
            ))}
          </ul>
        )}
      </section>
    </GuardPage>
  );
}
