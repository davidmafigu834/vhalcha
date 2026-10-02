import { AccessDenied } from '../../../../components/access-denied';
import { RegisterForm } from '../../../../components/forms';
import { repositories, requirePageAccess } from '../../../../server/services';

export const metadata = { title: 'Register AI system' };

export default async function NewSystemPage() {
  const access = await requirePageAccess('ai_systems:write');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const environments = await repositories().environments.list(session.claims.oid);
  return (
    <>
      <h1 className="page-title">Register AI system</h1>
      <RegisterForm
        environments={environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          type: environment.type,
        }))}
        devModel={process.env.VHALCHA_DEV_MODEL || 'gpt-4.1-mini'}
      />
    </>
  );
}
