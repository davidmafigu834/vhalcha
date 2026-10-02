import { hasPermission } from '@vhalcha/auth';
import { getGuardSettings, listGuardPolicies } from '@vhalcha/database';
import { guardFailureModes } from '@vhalcha/guard';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage, ModeBadge } from '../../../../components/guard-ui';
import { saveGuardSettings } from '../../../../server/guard-actions';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Guard settings' };

export default async function GuardSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const notice = (await searchParams).notice;
  const services = getServices();
  const settings = await getGuardSettings(services.db, access.claims.oid);
  const policies = await listGuardPolicies(services.db, access.claims.oid, 'active');
  const enforcePolicies = policies.filter((policy) => policy.mode === 'enforce');
  const blockPolicies = enforcePolicies.filter((policy) => policy.document.actions.some((action) => action.type === 'block'));
  const redactPolicies = enforcePolicies.filter((policy) => policy.document.actions.some((action) => action.type === 'redact'));
  const canConfigure = hasPermission(access.role, 'guard:configure');
  const protectAvailable = services.config.GUARD_PROTECT_MODE_ENABLED;
  return (
    <GuardPage title="Guard settings" lead="Organisation defaults. Existing organisations stay in monitor mode.">
      {notice === 'saved' ? <p className="ok">Settings saved.</p> : null}
      {notice === 'invalid' ? <p className="error">Those settings could not be saved.</p> : null}
      {notice === 'confirm' ? <p className="error">Confirm Protect before enabling it.</p> : null}
      {notice === 'protect-disabled' ? <p className="error">Protect is not enabled for this deployment.</p> : null}
      <section className="panel">
        <h2>Guard mode</h2>
        <p>
          <ModeBadge mode={settings.mode} />
        </p>
        <p>Monitor: detect and log only. Protect: apply enforcement actions from active policies.</p>
        <p className="muted">
          {protectAvailable
            ? 'Guard Protect allows active policies to modify or stop supported AI requests. Existing organisations stay in monitor until an administrator confirms the change.'
            : 'GUARD_PROTECT_MODE_ENABLED is off, so Protect cannot be activated.'}
        </p>
        <p>
          {enforcePolicies.length} active enforce {enforcePolicies.length === 1 ? 'policy' : 'policies'}. {blockPolicies.length} may block requests. {redactPolicies.length} may redact requests.
        </p>
      </section>
      <section className="panel">
        <h2>Stored preferences</h2>
        <p className="muted">
          Failure behaviour applies when Guard cannot execute an action. Retention policy configured: automated retention enforcement is not yet active. Open incidents and audit records are not deleted.
        </p>
        {canConfigure ? (
          <form action={saveGuardSettings} className="filters">
            <label>
              Retention days
              <input name="retentionDays" type="number" min={7} max={3650} defaultValue={settings.retentionDays} />
            </label>
            <label>
              Enforcement failure behaviour
              <select name="enforcementFailureMode" defaultValue={settings.enforcementFailureMode}>
                {guardFailureModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'fail_open' ? 'Fail open' : mode === 'fail_closed' ? 'Fail closed' : 'Fallback adapter'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Audit logging</span>
              <input type="checkbox" name="auditLoggingEnabled" defaultChecked={settings.auditLoggingEnabled} />
            </label>
            <label>
              <span>Guard enabled</span>
              <input type="checkbox" name="guardEnabled" defaultChecked={settings.guardEnabled} />
            </label>
            <label>
              Organisation mode
              <select name="guardMode" defaultValue={settings.mode}>
                <option value="monitor">Monitor</option>
                <option value="protect" disabled={!protectAvailable}>
                  Protect
                </option>
              </select>
            </label>
            {protectAvailable ? (
              <label className="check">
                <input type="checkbox" name="confirmProtect" value="yes" />
                Enable Guard Protect? Active enforce-mode policies may block or redact supported AI requests. Review active policies before continuing.
              </label>
            ) : null}
            <button type="submit">Save settings</button>
          </form>
        ) : (
          <p>Retention {settings.retentionDays} days. Failure mode {settings.enforcementFailureMode}. Your role cannot change these.</p>
        )}
      </section>
      <section className="panel">
        <h2>Security scoring</h2>
        <p>The posture score starts at 100 and subtracts capped penalties for unprotected systems, unknown systems, open high-severity incidents, critical policy violations, unrestricted sensitive-data access, missing audit logging, overprivileged agents, and disabled Guard.</p>
        <p className="muted">Monitor mode is not a penalty. A score is withheld when the organisation has no AI systems.</p>
      </section>
      <section className="panel">
        <h2>Data handling</h2>
        <p>Guard stores masked evidence and metadata. Raw prompts, provider keys and bearer tokens are stripped before an event is written.</p>
        <p>Content logging for the gateway remains metadata only.</p>
      </section>
    </GuardPage>
  );
}
