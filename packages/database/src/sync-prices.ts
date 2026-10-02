import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createDatabase } from './client';
import { syncCataloguePrices } from './catalogue-prices';

const executedDirectly = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href,
);

export async function runPriceSync(connectionString: string): Promise<number> {
  const { db, pool } = createDatabase(connectionString);
  try {
    return await syncCataloguePrices(db);
  } finally {
    await pool.end();
  }
}

if (executedDirectly) {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Invalid environment configuration: DATABASE_ADMIN_URL');
    process.exit(1);
  }
  runPriceSync(connectionString)
    .then((updated) => {
      console.log(`Updated ${updated} catalogue prices. Savings use price_verified_at from this run.`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Price sync failed');
      process.exit(1);
    });
}
