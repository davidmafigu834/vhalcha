import { notFound } from 'next/navigation';
import { getGuardPolicy, getGuardSettings, listGuardPolicyReferences } from '@vhalcha/database';
import type { GuardMode, GuardPolicyCategory } from '@vhalcha/guard';
import { AccessDenied } from '../../../../../../components/access-denied';
import { GuardPage } from '../../../../../../components/guard-ui';
import { PolicyBuilder } from '../../../../../../components/policy-builder';
import { getServices, requirePageAccess } from '../../../../../../server/services';

export const metadata = { title: 'Edit Guard policy' };

export default async function EditGuardPolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const access = await requirePageAccess('guard:policy:edit');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const { id } = await params;
  const notice = (await searchParams).notice;
  const services = getServices();
  const detail = await getGuardPolicy(services.db, access.claims.oid, id);
  if (!detail) notFound();
  const [references, settings] = await Promise.all([
    listGuardPolicyReferences(services.db, access.claims.oid),
    getGuardSettings(services.db, access.claims.oid),
  ]);
  return (
    <GuardPage title={`Edit ${detail.policy.name}`} lead="Saving creates a new version. Earlier versions stay attached to past decisions.">
      {notice ? <p className="error">{notice}</p> : null}
      <PolicyBuilder
        initial={{
          policyId: detail.policy.id,
          name: detail.policy.name,
          description: detail.policy.description,
          category: detail.policy.category as GuardPolicyCategory,
          priority: detail.policy.priority,
          mode: detail.policy.mode,
          document: detail.policy.document,
        }}
        references={{
          ...references,
          organisationMode: settings.mode as GuardMode,
          protectCapability: services.config.GUARD_PROTECT_MODE_ENABLED,
        }}
      />
    </GuardPage>
  );
}
