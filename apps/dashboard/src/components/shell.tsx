import Link from 'next/link';
import type { ReactNode } from 'react';
import type { UserRole } from '@vhalcha/types';
import { signOut } from '../server/actions';

const primary = [
  ['Overview', '/overview'],
  ['AI Systems', '/systems'],
  ['Guard', '/guard'],
  ['Knowledge', '/knowledge'],
  ['Gateway', '/gateway'],
  ['Spend', '/spend'],
  ['Audit Log', '/audit'],
  ['Settings', '/settings'],
] as const;

const later = [
  ['Registry', '/modules/registry'],
  ['Trust', '/modules/trust'],
  ['Policies', '/modules/policies'],
  ['Reports', '/modules/reports'],
] as const;

export function Shell({
  pathname,
  organisation,
  user,
  children,
}: {
  pathname: string;
  organisation: string;
  user: { name: string; role: UserRole };
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="brand-mark">Vhalcha</p>
          <p className="muted">The AI control plane for organisations.</p>
        </div>
        <nav aria-label="Primary">
          {primary.map(([label, href]) => (
            <Link key={href} href={href} aria-current={pathname.startsWith(href) ? 'page' : undefined}>
              {label}
            </Link>
          ))}
          <p className="nav-label">Not in this release</p>
          {later.map(([label, href]) => (
            <Link key={href} href={href}>
              {label}
              <span className="badge-soon">V1 later</span>
            </Link>
          ))}
        </nav>
      </aside>
      <div className="main">
        <div className="mobile-nav">
          <strong>Vhalcha</strong>
          <details>
            <summary>Menu</summary>
            {primary.map(([label, href]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </details>
        </div>
        <header className="topbar">
          <div>
            <strong>{organisation}</strong>
            <div className="muted">{user.name}</div>
          </div>
          <form action={signOut}>
            <button className="secondary" type="submit">
              Sign out
            </button>
          </form>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
