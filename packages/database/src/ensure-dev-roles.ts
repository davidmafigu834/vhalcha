import pg from 'pg';

const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
const appPassword = process.env.VHALCHA_APP_DB_PASSWORD;
const workerPassword = process.env.VHALCHA_WORKER_DB_PASSWORD;

if (process.env.VHALCHA_ENV === 'production') {
  console.error('Refusing to set development role passwords in production.');
  process.exit(1);
}
if (!adminUrl || !appPassword || !workerPassword) {
  console.error('Invalid environment configuration: DATABASE_ADMIN_URL, VHALCHA_APP_DB_PASSWORD, VHALCHA_WORKER_DB_PASSWORD');
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const databaseName = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, ''));
  await client.query(`alter role vhalcha_app with login password ${client.escapeLiteral(appPassword)}`);
  await client.query(`alter role vhalcha_worker with login password ${client.escapeLiteral(workerPassword)}`);
  await client.query(`grant connect on database ${client.escapeIdentifier(databaseName)} to vhalcha_app, vhalcha_worker`);
  console.log('Development database roles can log in. Application traffic should use vhalcha_app. Workers should use vhalcha_worker.');
} finally {
  await client.end();
}
