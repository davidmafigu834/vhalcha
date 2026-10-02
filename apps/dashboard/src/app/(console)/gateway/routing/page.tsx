import Link from 'next/link';
import { createRepositories, createRoutingRepository } from '@vhalcha/database';
import { hasPermission } from '@vhalcha/auth';
import { AccessDenied } from '../../../../components/access-denied';
import { getServices, requirePageAccess } from '../../../../server/services';
import { updateRoutingPolicy } from '../../../../server/routing-actions';

export const metadata = { title: 'Routing' };

export default async function RoutingPage() {
  const access = await requirePageAccess('routing:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const db = getServices().db;
  const systems = await createRepositories(db).aiSystems.list(session.claims.oid);
  const routing = createRoutingRepository(db);
  const catalogue = await routing.listCatalogue();
  const modelAccess = await routing.listAccess(session.claims.oid);
  const approvedIds = new Set(modelAccess.filter((row) => row.status === 'allowed').map((row) => row.modelCatalogueId));
  const approvedCatalogue = catalogue.filter((model) => approvedIds.has(model.id));
  const canWrite = hasPermission(session.role, 'routing:write');
  return (
    <>
      <h1 className="page-title">Routing</h1>
      <nav className="row-actions">
        <Link href="/gateway">Overview</Link>
        <Link href="/gateway/routing">Routing</Link>
        <Link href="/gateway/models">Models</Link>
        <Link href="/gateway/providers">Providers</Link>
      </nav>
      <p className="muted">Estimated optimisation benefit compares a configured, organisation-approved baseline model with the selected route using catalogue token prices. It is not a provider invoice. Request size is message length, not a judgement of task difficulty. Routing does not yet detect vision or tool requirements from the public request.</p>
      {systems.length === 0 ? <p>No AI systems yet.</p> : null}
      {systems.map((system) => (
        <article key={system.id} className="panel">
          <h2>{system.name}</h2>
          <p>Mode: {system.routingMode}</p>
          <p>Strategy: {system.routingStrategy}</p>
          <p>Baseline: {catalogue.find((model) => model.id === system.baselineModelId)?.displayName ?? 'Baseline not configured'}</p>
          <p>Premium escalation: {system.premiumEscalation ? 'enabled' : 'disabled'}</p>
          <p>Fallback: {system.fallbackEnabled ? 'enabled' : 'disabled'}</p>
          <p>Maximum estimated request cost: {system.maxRequestCostUsd ?? 'not set'}</p>
          <p className="muted">
            Allowed providers are a hard filter. Preferred providers are a soft tie-break outside Cost strategy.
            Cost mode ignores preferred providers and still selects the cheapest qualifying model.
          </p>
          {canWrite ? (
            <form action={updateRoutingPolicy}>
              <input type="hidden" name="ai_system_id" value={system.id} />
              <label>Mode
                <select name="routing_mode" defaultValue={system.routingMode}>
                  <option value="fixed">Fixed</option>
                  <option value="optimised">Optimised</option>
                </select>
              </label>
              <label>Strategy
                <select name="routing_strategy" defaultValue={system.routingStrategy}>
                  <option value="cost">Cost</option>
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                  <option value="latency">Latency</option>
                </select>
              </label>
              <label>Baseline model (must be organisation-approved)
                <select name="baseline_model_id" defaultValue={system.baselineModelId ?? ''}>
                  <option value="">Baseline not configured</option>
                  {approvedCatalogue.map((model) => (
                    <option key={model.id} value={model.id}>{model.displayName}</option>
                  ))}
                </select>
              </label>
              <label>Maximum estimated request cost
                <input name="max_request_cost_usd" defaultValue={system.maxRequestCostUsd ?? ''} />
              </label>
              <label>Allowed providers (comma-separated; empty = all eligible)
                <input
                  name="allowed_providers"
                  defaultValue={Array.isArray((system.routingConstraints as { allowed_providers?: unknown })?.allowed_providers)
                    ? ((system.routingConstraints as { allowed_providers: string[] }).allowed_providers).join(', ')
                    : ''}
                  placeholder="openai, anthropic, google"
                />
              </label>
              <label>Preferred providers (soft factor; ignored by Cost)
                <input
                  name="preferred_providers"
                  defaultValue={Array.isArray((system.routingConstraints as { preferred_providers?: unknown })?.preferred_providers)
                    ? ((system.routingConstraints as { preferred_providers: string[] }).preferred_providers).join(', ')
                    : ''}
                  placeholder="anthropic"
                />
              </label>
              <label>Prohibited providers (deny list)
                <input
                  name="prohibited_providers"
                  defaultValue={Array.isArray((system.routingConstraints as { prohibited_providers?: unknown })?.prohibited_providers)
                    ? ((system.routingConstraints as { prohibited_providers: string[] }).prohibited_providers).join(', ')
                    : ''}
                  placeholder="google"
                />
              </label>
              <label><input type="checkbox" name="premium_escalation" defaultChecked={system.premiumEscalation} /> Premium escalation</label>
              <label><input type="checkbox" name="fallback_enabled" defaultChecked={system.fallbackEnabled} /> Fallback</label>
              <button type="submit">Save routing</button>
            </form>
          ) : null}
        </article>
      ))}
    </>
  );
}
