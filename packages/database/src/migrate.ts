import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { isDuplicateObject, splitSqlStatements } from './sql-script';

export async function applyMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    const files = (await readdir(directory))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    for (const file of files) {
      const existing = await client.query('select id from schema_migrations where id = $1', [file]);
      if (existing.rowCount) {
        continue;
      }
      const sqlText = await readFile(path.join(directory, file), 'utf8');
      const outsideTransaction = sqlText.startsWith('-- no-transaction');
      if (outsideTransaction) {
        for (const statement of splitSqlStatements(sqlText)) {
          try {
            await client.query(statement);
          } catch (error) {
            if (!isDuplicateObject(error)) {
              throw error;
            }
          }
        }
        await client.query('insert into schema_migrations (id) values ($1)', [file]);
        applied.push(file);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sqlText);
        await client.query('insert into schema_migrations (id) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

const executedDirectly = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href,
);

if (executedDirectly) {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Invalid environment configuration: DATABASE_ADMIN_URL');
    process.exit(1);
  }
  if (process.env.VHALCHA_ENV === 'production' && process.env.VHALCHA_CONFIRM_PRODUCTION_MIGRATE !== 'yes') {
    console.error('Refusing to migrate production without VHALCHA_CONFIRM_PRODUCTION_MIGRATE=yes');
    process.exit(1);
  }
  applyMigrations(connectionString)
    .then((applied) => {
      console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Migrations already applied');
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Migration failed';
      console.error(message);
      process.exit(1);
    });
}
