import Link from 'next/link';
import { createRoutingRepository } from '@vhalcha/database';
import { hasPermission } from '@vhalcha/auth';
import { AccessDenied } from '../../../../components/access-denied';
import { usd } from '../../../../lib/format';
import { getServices, requirePageAccess } from '../../../../server/services';
import { setOrganisationModel } from '../../../../server/routing-actions';

export const metadata = { title: 'Models' };

export default async function ModelsPage() {
  const access = await requirePageAccess('routing:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const routing = createRoutingRepository(getServices().db);
  const [catalogue, accessRows] = await Promise.all([
    routing.listCatalogue(),
    routing.listAccess(session.claims.oid),
  ]);
  const byModel = new Map(accessRows.map((row) => [row.modelCatalogueId, row.status]));
  const canManage = hasPermission(session.role, 'routing:manage');
  return (
    <>
      <h1 className="page-title">Models</h1>
      <nav className="row-actions">
        <Link href="/gateway">Overview</Link>
        <Link href="/gateway/routing">Routing</Link>
        <Link href="/gateway/models">Models</Link>
        <Link href="/gateway/providers">Providers</Link>
      </nav>
      <p className="muted">Catalogue prices are platform metadata. Organisation access is separate. Estimated request and spend columns appear after routed traffic exists.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th>Tier</th>
              <th>Input / 1M</th>
              <th>Output / 1M</th>
              <th>Context</th>
              <th>Capabilities</th>
              <th>Organisation</th>
            </tr>
          </thead>
          <tbody>
            {catalogue.length === 0 ? (
              <tr><td colSpan={8}>No catalogue models.</td></tr>
            ) : catalogue.map((model) => (
              <tr key={model.id}>
                <td>{model.displayName}</td>
                <td>{model.provider}</td>
                <td>{model.tier}</td>
                <td>{usd(Number(model.inputUsdPerMillion))}</td>
                <td>{usd(Number(model.outputUsdPerMillion))}</td>
                <td>{model.contextWindow}</td>
                <td>{model.capabilities.join(', ')}</td>
                <td>
                  {byModel.get(model.id) ?? 'not approved'}
                  {canManage ? (
                    <form action={setOrganisationModel}>
                      <input type="hidden" name="model_catalogue_id" value={model.id} />
                      <input type="hidden" name="status" value={byModel.get(model.id) === 'allowed' ? 'blocked' : 'allowed'} />
                      <button type="submit">{byModel.get(model.id) === 'allowed' ? 'Block' : 'Allow'}</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
