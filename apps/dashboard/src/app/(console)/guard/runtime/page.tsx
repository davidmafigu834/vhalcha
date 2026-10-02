import { getGuardOverview, getGuardSettings } from '@vhalcha/database';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage } from '../../../../components/guard-ui';
import { when } from '../../../../lib/format';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Guard runtime' };

async function gatewayHealth(baseUrl: string): Promise<'Connected' | 'Degraded' | 'Offline'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const [health, ready] = await Promise.all([
      fetch(new URL('/health', baseUrl), { signal: controller.signal, cache: 'no-store' }),
      fetch(new URL('/ready', baseUrl), { signal: controller.signal, cache: 'no-store' }),
    ]);
    if (health.ok && ready.ok) return 'Connected';
    if (health.ok) return 'Degraded';
    return 'Offline';
  } catch {
    return 'Offline';
  } finally {
    clearTimeout(timer);
  }
}

export default async function GuardRuntimePage() {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const services = getServices();
  const gateway = await gatewayHealth(services.config.VHALCHA_GATEWAY_URL);
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const [settings, overview] = await Promise.all([
    getGuardSettings(services.db, access.claims.oid),
    getGuardOverview(services.db, access.claims.oid, { start, end }, { deploymentGuardEnabled: services.config.GUARD_ENABLED }),
  ]);
  const last = overview.events[0];
  return (
    <GuardPage title="Runtime" lead="Vhalcha Gateway is the live Guard runtime. OpenShell is not integrated.">
      <section className="grid-3">
        <article className="panel">
          <h2>Vhalcha Gateway</h2>
          <p>{gateway}</p>
          <p>{services.config.GUARD_ENABLED && settings.guardEnabled ? 'Guard inspection active' : 'Guard inspection off'}</p>
          <p>Protect capability: {services.config.GUARD_PROTECT_MODE_ENABLED ? 'Enabled for organisations that choose it' : 'Off'}</p>
          <p>Organisation mode: {settings.mode.toUpperCase()}</p>
          <p>Requests inspected, last 24h: {overview.metrics.requestsInspected}</p>
          <p>Blocked: {overview.metrics.blockedRequests}</p>
          <p>Redacted: {overview.metrics.redactedRequests}</p>
          <p>Last Guard event: {last ? when(last.occurredAt) : 'None yet'}</p>
          <p className="muted">Counters come from live gateway Guard events. Tester and simulation decisions are not included.</p>
        </article>
        <article className="panel">
          <h2>NVIDIA OpenShell</h2>
          <p>Not integrated</p>
          <p className="muted">
            OpenShell is an optional adapter. {services.config.GUARD_OPEN_SHELL_ENABLED ? 'The feature flag is on, but no endpoint is stored.' : 'The feature flag is off.'} No NVIDIA API is called.
          </p>
        </article>
        <article className="panel">
          <h2>External enforcement</h2>
          <p>0 integrations</p>
          <p className="muted">No external enforcement endpoint is configured.</p>
        </article>
      </section>
    </GuardPage>
  );
}
