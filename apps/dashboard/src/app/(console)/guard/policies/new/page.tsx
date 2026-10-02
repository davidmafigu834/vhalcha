import { getGuardSettings, listGuardPolicyReferences } from '@vhalcha/database';
import { GUARD_POLICY_PRIORITY_DEFAULT, policyTemplate, type GuardMode } from '@vhalcha/guard';
import { AccessDenied } from '../../../../../components/access-denied';
import { GuardPage } from '../../../../../components/guard-ui';
import { PolicyBuilder, type PolicyBuilderInitial } from '../../../../../components/policy-builder';
import { getServices, requirePageAccess } from '../../../../../server/services';

export const metadata = { title: 'Create Guard policy' };

const blank: PolicyBuilderInitial = {
  name: '',
  description: '',
  category: 'data',
  priority: GUARD_POLICY_PRIORITY_DEFAULT,
  mode: 'monitor',
  document: {
    scope: { organizationWide: true },
    conditions: { logic: 'all', conditions: [{ field: 'environment', operator: 'equals', value: 'production' }] },
    actions: [{ type: 'monitor' }],
  },
};

export default async function NewGuardPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; notice?: string }>;
}) {
  const access = await requirePageAccess('guard:policy:create');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const params = await searchParams;
  const template = params.template ? policyTemplate(params.template) : null;
  const services = getServices();
  const [references, settings] = await Promise.all([
    listGuardPolicyReferences(services.db, access.claims.oid),
    getGuardSettings(services.db, access.claims.oid),
  ]);
  const initial: PolicyBuilderInitial = template
    ? {
        name: template.name,
        description: template.description,
        category: template.category,
        priority: template.priority,
        mode: template.mode,
        document: template.document,
      }
    : blank;
  return (
    <GuardPage title="Create policy" lead="Templates become drafts. Nothing is active until you activate it.">
      {params.notice ? <p className="error">{params.notice}</p> : null}
      {template?.caution ? <p className="guard-banner">{template.caution}</p> : null}
      <PolicyBuilder
        initial={initial}
        references={{
          ...references,
          organisationMode: settings.mode as GuardMode,
          protectCapability: services.config.GUARD_PROTECT_MODE_ENABLED,
        }}
      />
    </GuardPage>
  );
}
