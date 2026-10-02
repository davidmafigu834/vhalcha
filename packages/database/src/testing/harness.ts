import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../schema';
import { isDuplicateObject, splitSqlStatements } from '../sql-script';

export async function createTestDatabase() {
  const client = new PGlite({ extensions: { vector } });
  const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  const files = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sqlText = readFileSync(path.join(migrationDirectory, file), 'utf8');
    if (sqlText.startsWith('-- no-transaction')) {
      for (const statement of splitSqlStatements(sqlText)) {
        try {
          await client.exec(statement);
        } catch (error) {
          if (!isDuplicateObject(error)) {
            throw error;
          }
        }
      }
      continue;
    }
    await client.exec(sqlText);
  }
  const db = drizzle(client, { schema });
  return { client, db };
}
