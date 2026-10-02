import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Shell } from '../../components/shell';
import { readSession, repositories } from '../../server/services';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await readSession();
  if (!session) {
    redirect('/sign-in');
  }
  const organisation = await repositories().organisations.findById(session.claims.oid);
  const pathname = (await headers()).get('x-pathname') ?? '';
  return (
    <Shell pathname={pathname} organisation={organisation?.name ?? 'Organisation'} user={session}>
      {children}
    </Shell>
  );
}
