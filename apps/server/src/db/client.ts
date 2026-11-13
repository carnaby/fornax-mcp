import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/db → ../../drizzle; dist/src/db → ../../../drizzle. Both point at apps/server/drizzle.
const MIGRATIONS = [join(here, '..', '..', 'drizzle'), join(here, '..', '..', '..', 'drizzle')].find((p) => existsSync(p));

export function openDb(file: string) {
  if (!MIGRATIONS) throw new Error('drizzle migrations folder not found');
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, sqlite, close: () => sqlite.close() };
}

export type Db = ReturnType<typeof openDb>['db'];
