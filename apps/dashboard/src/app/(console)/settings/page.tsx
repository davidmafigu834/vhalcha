import { hasPermission } from '@vhalcha/auth';
import { AccessDenied } from '../../../components/access-denied';
import { repositories, getServices, requirePageAccess } from '../../../server/services';
import { createEnvironment, createProviderConnection, updateOrganisation, updateUserRole } from '../../../server/actions';

export const metadata = { title: 'Settings' };

const sections = ['organisation', 'users', 'environments', 'providers', 'developer'] as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; notice?: string }>;
}) {
  const access = await requirePageAccess('settings:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const query = await searchParams;
  const section = query.section ?? 'organisation';
  const repos = repositories();
  const organisation = await repos.organisations.findById(session.claims.oid);
  const users = hasPermission(session.role, 'users:read') ? await repos.users.list(session.claims.oid) : [];
  const environments = hasPermission(session.role, 'environments:read')
    ? await repos.environments.list(session.claims.oid)
    : [];
  const providers = hasPermission(session.role, 'providers:read')
    ? await repos.providerConnections.list(session.claims.oid)
    : [];
  const gatewayUrl = getServices().config.VHALCHA_GATEWAY_URL;
  const canWriteOrg = hasPermission(session.role, 'organisations:write');
  const canWriteUsers = hasPermission(session.role, 'users:write');
  const canWriteEnv = hasPermission(session.role, 'environments:write');
  const canWriteProviders = hasPermission(session.role, 'providers:write');
  return (
    <>
      <h1 className="page-title">Settings</h1>
      {query.notice ? <p className="error">{query.notice}</p> : null}
      <nav className="row-actions">
        {sections.map((item) => (
          <a key={item} href={`/settings?section=${item}`} aria-current={section === item ? 'page' : undefined}>
            {item}
          </a>
        ))}
      </nav>
      {section === 'organisation' && organisation ? (
        <form className="panel grid-2" action={updateOrganisation}>
          <label>Name<input name="name" defaultValue={organisation.name} disabled={!canWriteOrg} /></label>
          <label>Timezone<input name="timezone" defaultValue={organisation.timezone} disabled={!canWriteOrg} /></label>
          <p>Currency: {organisation.defaultCurrency}</p>
          <p>Content logging: {organisation.contentLoggingMode}</p>
          {canWriteOrg ? <button type="submit">Save organisation</button> : <p>Read only.</p>}
        </form>
      ) : null}
      {section === 'users' && !hasPermission(session.role, 'users:read') ? (
        <AccessDenied />
      ) : null}
      {section === 'users' && hasPermission(session.role, 'users:read') ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>
                    {canWriteUsers ? (
                      <form action={updateUserRole} className="inline-form">
                        <input type="hidden" name="userId" value={user.id} />
                        <select name="role" defaultValue={user.role}>
                          {['owner', 'ai_admin', 'developer', 'security_admin', 'finance_manager', 'viewer'].map((role) => (
                            <option key={role}>{role}</option>
                          ))}
                        </select>
                        <button className="secondary" type="submit">Update</button>
                      </form>
                    ) : user.role}
                  </td>
                  <td>{user.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {section === 'environments' ? (
        <section className="panel">
          <ul>{environments.map((environment) => <li key={environment.id}>{environment.name} · {environment.type}</li>)}</ul>
          {canWriteEnv ? (
            <form action={createEnvironment} className="inline-form">
              <label>Name<input name="name" required /></label>
              <label>Type
                <select name="type" defaultValue="development">
                  <option>development</option>
                  <option>staging</option>
                  <option>production</option>
                </select>
              </label>
              <button type="submit">Add environment</button>
            </form>
          ) : null}
        </section>
      ) : null}
      {section === 'providers' ? (
        <section className="panel">
          <p>V1 activates OpenAI through the platform environment variable. Customer-managed keys are not stored.</p>
          <ul>
            {providers.map((connection) => (
              <li key={connection.id}>{connection.name} · {connection.provider} · {connection.credentialSource} · {connection.status}</li>
            ))}
          </ul>
          {canWriteProviders ? (
            <form action={createProviderConnection} className="inline-form">
              <label>Name<input name="name" defaultValue="OpenAI" /></label>
              <label>Environment
                <select name="environmentId">
                  {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
                </select>
              </label>
              <input type="hidden" name="credentialSource" value="platform_env" />
              <button type="submit">Add platform connection</button>
            </form>
          ) : null}
        </section>
      ) : null}
      {section === 'developer' ? (
        <section className="panel">
          <p>Gateway base URL</p>
          <p className="mono">{gatewayUrl}</p>
          <p>API documentation: <a href="/docs/gateway-api">docs/gateway-api.md</a></p>
          <pre className="mono">{`curl ${gatewayUrl}/v1/chat/completions \\
  -H "Authorization: Bearer vh_test_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${process.env.VHALCHA_DEV_MODEL || 'gpt-4.1-mini'}","messages":[{"role":"user","content":"Explain our return policy."}]}'`}</pre>
          <p>SDK status: @vhalcha/sdk exposes a minimal chat.completions.create client.</p>
        </section>
      ) : null}
    </>
  );
}
