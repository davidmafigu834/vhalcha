import Link from 'next/link';
import { hasPermission } from '@vhalcha/auth';
import { listGuardPolicies } from '@vhalcha/database';
import { guardPolicyTemplates, type GuardPolicyDocument, type GuardPolicyStatus } from '@vhalcha/guard';
import { AccessDenied } from '../../../../components/access-denied';
import { GuardPage } from '../../../../components/guard-ui';
import { when } from '../../../../lib/format';
import { getServices, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Guard policies' };

function scopeText(document: GuardPolicyDocument) {
  if (document.scope.organizationWide) return 'Entire organisation';
  const parts: string[] = [];
  const systems = document.scope.systemIds?.length ?? 0;
  if (systems > 0) parts.push(`${systems} AI system${systems === 1 ? '' : 's'}`);
  if ((document.scope.environments?.length ?? 0) > 0) parts.push(document.scope.environments?.join(', ') ?? '');
  if ((document.scope.providers?.length ?? 0) > 0) parts.push(`${document.scope.providers?.length} providers`);
  if ((document.scope.models?.length ?? 0) > 0) parts.push(`${document.scope.models?.length} models`);
  return parts.join(' · ') || 'Limited scope';
}

export default async function GuardPoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; notice?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const params = await searchParams;
  const tab = params.tab === 'draft' || params.tab === 'disabled' || params.tab === 'templates' ? params.tab : 'active';
  const policies = await listGuardPolicies(getServices().db, access.claims.oid);
  const visible = tab === 'templates' ? [] : policies.filter((policy) => policy.status === (tab as GuardPolicyStatus));
  const canCreate = hasPermission(access.role, 'guard:policy:create');
  return (
    <GuardPage
      title="Policies"
      lead="Define how AI systems may use models, providers, data and tools."
      actions={
        <>
          {canCreate ? (
            <Link className="button" href="/guard/policies/new">
              Create policy
            </Link>
          ) : null}
          <Link className="button secondary" href="/guard/policies?tab=templates">
            Policy library
          </Link>
        </>
      }
    >
      {params.notice ? <p className="ok">{params.notice === 'deleted' ? 'Draft policy deleted.' : params.notice}</p> : null}
      <nav className="tabs" aria-label="Policy status">
        {(
          [
            ['active', 'Active'],
            ['draft', 'Draft'],
            ['disabled', 'Disabled'],
            ['templates', 'Templates'],
          ] as const
        ).map(([value, label]) => (
          <Link key={value} href={`/guard/policies?tab=${value}`} aria-current={tab === value ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {policies.length === 0 && tab !== 'templates' ? (
        <section className="panel">
          <h2>Define how AI may operate</h2>
          <p>Create policies for data, models, providers, tools and agent actions.</p>
          <div className="button-row">
            {canCreate ? (
              <Link className="button" href="/guard/policies/new">
                Create policy
              </Link>
            ) : null}
            <Link className="button secondary" href="/guard/policies?tab=templates">
              Browse policy library
            </Link>
          </div>
        </section>
      ) : null}
      {tab === 'templates' ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Category</th>
                <th>Priority</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {guardPolicyTemplates.map((template) => (
                <tr key={template.id}>
                  <td>
                    <strong>{template.name}</strong>
                    <div className="muted">{template.description}</div>
                  </td>
                  <td>{template.category}</td>
                  <td>{template.priority}</td>
                  <td>
                    {canCreate ? <Link href={`/guard/policies/new?template=${template.id}`}>Use template</Link> : <span className="muted">Draft only</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : policies.length === 0 ? null : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Policy</th>
                <th>Category</th>
                <th>Scope</th>
                <th>Mode</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Version</th>
                <th>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={8}>No {tab} policies.</td>
                </tr>
              ) : (
                visible.map((policy) => (
                  <tr key={policy.id}>
                    <td>
                      <Link href={`/guard/policies/${policy.id}`}>{policy.name}</Link>
                      {policy.description ? <div className="muted">{policy.description}</div> : null}
                    </td>
                    <td>{policy.category}</td>
                    <td>{scopeText(policy.document)}</td>
                    <td>{policy.mode}</td>
                    <td>{policy.priority}</td>
                    <td>{policy.status.toUpperCase()}</td>
                    <td>v{policy.currentVersion}</td>
                    <td>{when(policy.updatedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">Existing model access rules run independently. Guard policies do not replace them, and a Guard allow does not bypass a model denial.</p>
    </GuardPage>
  );
}
