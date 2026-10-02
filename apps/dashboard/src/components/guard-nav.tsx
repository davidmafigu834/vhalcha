import Link from 'next/link';

const links = [
  ['Overview', '/guard'],
  ['Inventory', '/guard/inventory'],
  ['Policies', '/guard/policies'],
  ['Runtime', '/guard/runtime'],
  ['Data', '/guard/data-security'],
  ['Threats', '/guard/threats'],
  ['Incidents', '/guard/incidents'],
  ['Permissions', '/guard/permissions'],
  ['Audit', '/guard/audit'],
  ['Integrations', '/guard/integrations'],
  ['Settings', '/guard/settings'],
] as const;

export function GuardNav({ pathname }: { pathname: string }) {
  return (
    <nav className="guard-nav" aria-label="Guard">
      {links.map(([label, href]) => {
        const current = href === '/guard' ? pathname === '/guard' : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={current ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
