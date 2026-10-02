import Link from 'next/link';
import { byokStorageAvailable } from '@vhalcha/config';
import { createRepositories } from '@vhalcha/database';
import { hasPermission } from '@vhalcha/auth';
import { AccessDenied } from '../../../../components/access-denied';
import { getServices, requirePageAccess } from '../../../../server/services';
import {
  connectOrganisationProvider,
  disableProviderConnection,
  enablePlatformProvider,
  testProviderConnection,
} from '../../../../server/routing-actions';

export const metadata = { title: 'Providers' };

function platformKeyPresent(provider: string) {
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  if (provider === 'google') return Boolean(process.env.GOOGLE_API_KEY?.trim());
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function verificationLabel(
  status: string,
  errorCode: string | null,
  credentialSource: string,
  provider: string,
  connectionStatus: string,
) {
  if (connectionStatus !== 'active') {
    return connectionStatus;
  }
  if (credentialSource === 'platform_env') {
    return platformKeyPresent(provider) ? 'Available' : 'Unavailable — platform credential missing';
  }
  if (status === 'verified') {
    return 'Verified';
  }
  if (status === 'failed') {
    if (errorCode === 'provider_authentication_failed') {
      return 'Connection failed — Authentication rejected';
    }
    if (errorCode === 'provider_timeout') {
      return 'Connection failed — Timeout';
    }
    if (errorCode === 'provider_unavailable') {
      return 'Connection failed — Provider unavailable';
    }
    return 'Connection failed';
  }
  return 'Unverified';
}

export default async function ProvidersPage() {
  const access = await requirePageAccess('providers:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const repos = createRepositories(getServices().db);
  const [connections, environments] = await Promise.all([
    repos.providerConnections.list(session.claims.oid),
    repos.environments.list(session.claims.oid),
  ]);
  const canWrite = hasPermission(session.role, 'providers:write');
  const byokEnabled = byokStorageAvailable(process.env.VHALCHA_SECRETS_KEY);
  return (
    <>
      <h1 className="page-title">Providers</h1>
      <nav className="row-actions">
        <Link href="/gateway">Overview</Link>
        <Link href="/gateway/routing">Routing</Link>
        <Link href="/gateway/models">Models</Link>
        <Link href="/gateway/providers">Providers</Link>
      </nav>
      <p className="muted">
        Credentials stay encrypted. An organisation must explicitly connect BYOK or opt into a Vhalcha platform credential.
        Environment API keys alone do not make a provider eligible. This page never shows an API key or a raw vendor payload.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Name</th>
              <th>Status</th>
              <th>Verification</th>
              <th>Credential source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {connections.length === 0 ? (
              <tr><td colSpan={6}>No provider connections.</td></tr>
            ) : connections.map((connection) => (
              <tr key={connection.id}>
                <td>{connection.provider}</td>
                <td>{connection.name}</td>
                <td>{connection.status}</td>
                <td>
                  {verificationLabel(
                    connection.verificationStatus,
                    connection.verificationErrorCode ?? null,
                    connection.credentialSource,
                    connection.provider,
                    connection.status,
                  )}
                </td>
                <td>{connection.credentialSource}</td>
                <td className="row-actions">
                  {canWrite && connection.status === 'active' && connection.credentialSource === 'organisation' ? (
                    <form action={testProviderConnection}>
                      <input type="hidden" name="connection_id" value={connection.id} />
                      <button type="submit">Test connection</button>
                    </form>
                  ) : null}
                  {canWrite && connection.status === 'active' ? (
                    <form action={disableProviderConnection}>
                      <input type="hidden" name="connection_id" value={connection.id} />
                      <button type="submit">Disable</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canWrite ? (
        <form action={enablePlatformProvider}>
          <h2>Use a Vhalcha platform credential</h2>
          <label>Provider
            <select name="provider" defaultValue="openai">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
            </select>
          </label>
          <label>Environment
            <select name="environment_id">
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>{environment.name}</option>
              ))}
            </select>
          </label>
          <button type="submit">Enable platform credential</button>
          <p className="muted">
            This opts the organisation into the Gateway environment key for that provider. The key is never copied into the tenant row.
          </p>
        </form>
      ) : null}
      {canWrite && byokEnabled ? (
        <form action={connectOrganisationProvider}>
          <h2>Connect an organisation credential</h2>
          <label>Provider
            <select name="provider" defaultValue="openai">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
            </select>
          </label>
          <label>Environment
            <select name="environment_id">
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>{environment.name}</option>
              ))}
            </select>
          </label>
          <label>API key
            <input name="api_key" type="password" autoComplete="off" />
          </label>
          <button type="submit">Connect</button>
          <p className="muted">
            The key is encrypted before it is stored. Vhalcha then calls a cheap models list endpoint to mark the connection Verified or Failed.
            Vhalcha-managed billing is not enabled.
          </p>
        </form>
      ) : null}
      {canWrite && !byokEnabled ? (
        <p>Organisation provider credentials are disabled until VHALCHA_SECRETS_KEY is configured.</p>
      ) : null}
    </>
  );
}
