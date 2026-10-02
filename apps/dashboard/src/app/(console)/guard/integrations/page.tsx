import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage } from '../../../../components/guard-ui';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Guard integrations' };

export default async function IntegrationsPage() {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const openShell = getServices().config.GUARD_OPEN_SHELL_ENABLED;
  return (
    <GuardPage title="Integrations" lead="Connections Guard can use. A card is connected only when this deployment has a working integration.">
      <section className="panel">
        <h2>Runtime enforcement</h2>
        <p>Vhalcha Gateway: present in this deployment, not yet enforcing Guard decisions.</p>
        <p>NVIDIA OpenShell: {openShell ? 'flag enabled, endpoint not configured' : 'not configured'}.</p>
        <p>External enforcement: 0 integrations.</p>
      </section>
      <section className="panel">
        <h2>Identity</h2>
        <p className="empty">No additional identity provider is connected for Guard. Dashboard sessions use the existing Vhalcha login.</p>
      </section>
      <section className="panel">
        <h2>SIEM / security</h2>
        <p className="empty">No SIEM export is configured.</p>
      </section>
      <section className="panel">
        <h2>Notifications</h2>
        <p className="empty">No security-event webhook is configured. Webhook delivery is not active in this release.</p>
      </section>
    </GuardPage>
  );
}
