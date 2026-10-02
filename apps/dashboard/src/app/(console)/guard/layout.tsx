import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { GuardNav } from '../../../components/guard-nav';

export const dynamic = 'force-dynamic';

export default async function GuardLayout({ children }: { children: ReactNode }) {
  const pathname = (await headers()).get('x-pathname') ?? '';
  return (
    <>
      <GuardNav pathname={pathname} />
      {children}
    </>
  );
}
