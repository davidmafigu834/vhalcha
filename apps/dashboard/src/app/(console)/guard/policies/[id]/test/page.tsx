import { notFound } from 'next/navigation';
import { getGuardPolicy, listGuardPolicyReferences } from '@vhalcha/database';
import { AccessDenied } from '../../../../../../components/access-denied';
import { GuardPage } from '../../../../../../components/guard-ui';
import { PolicyTester } from '../../../../../../components/policy-tester';
import { getServices, requirePageAccess } from '../../../../../../server/services';

export const metadata = { title: 'Test Guard policy' };

export default async function TestGuardPolicyPage({
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
  const references = await listGuardPolicyReferences(services.db, access.claims.oid);
  return (
    <GuardPage title={`Test ${detail.policy.name}`} lead="Synthetic evaluation uses the same engine as a future gateway decision. No live request is modified.">
      {notice ? <p className="error">{notice}</p> : null}
      <PolicyTester policyId={detail.policy.id} systems={references.systems} providers={references.providers} models={references.models} />
    </GuardPage>
  );
}
