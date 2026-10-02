import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export type AppDatabase = NodePgDatabase<typeof schema>;

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
