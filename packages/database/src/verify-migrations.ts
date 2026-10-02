import pg from 'pg';

const required = ['0001_init.sql', '0002_budget_reservations.sql', '0003_tenant_rls.sql', '0004_knowledge.sql', '0005_routing.sql'];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Invalid environment configuration: DATABASE_URL');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const duplicates = await client.query<{ request_id: string }>(`
    select request_id::text as request_id
    from usage_events
    group by request_id
    having count(*) > 1
    order by request_id::text
  `);
  if (duplicates.rows.length > 0) {
    console.error(
      `usage_events has duplicate request_id values. Do not delete them from the migration: ${duplicates.rows
        .map((row) => row.request_id)
        .join(', ')}`,
    );
    process.exit(1);
  }
  const applied = await client.query<{ id: string }>('select id from schema_migrations order by id');
  const ids = applied.rows.map((row) => row.id);
  const missing = required.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    console.error(`Missing migrations: ${missing.join(', ')}`);
    process.exit(1);
  }
  const roles = await client.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(`
    select rolname, rolbypassrls, rolsuper
    from pg_roles
    where rolname in ('vhalcha_app', 'vhalcha_worker', 'vhalcha_migration', 'vhalcha_definer')
    order by rolname
  `);
  const byName = new Map(roles.rows.map((row) => [row.rolname, row]));
  for (const name of ['vhalcha_app', 'vhalcha_worker', 'vhalcha_migration']) {
    const role = byName.get(name);
    if (!role || role.rolsuper || role.rolbypassrls) {
      console.error(`${name} must exist without superuser or BYPASSRLS`);
      process.exit(1);
    }
  }
  const definer = byName.get('vhalcha_definer');
  if (!definer?.rolbypassrls || definer.rolsuper) {
    console.error('vhalcha_definer must exist with BYPASSRLS and without superuser');
    process.exit(1);
  }
  console.log(`Migrations applied: ${ids.join(', ')}`);
} finally {
  await client.end();
}
