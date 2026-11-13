import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session';
import type { MigrationConfig } from 'drizzle-orm/migrator';
import { BaseSQLiteDatabase, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';
import { SqliteDatabase } from './sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/db → ../../drizzle; dist/src/db → ../../../drizzle. Both point at apps/server/drizzle.
const MIGRATIONS = [join(here, '..', '..', 'drizzle'), join(here, '..', '..', '..', 'drizzle')].find((p) => existsSync(p));

// $client is the adapter, so only its methods (not better-sqlite3's) can be called on it.
export type Db = Omit<BetterSQLite3Database<typeof schema>, '$client'> & { $client: SqliteDatabase };

/**
 * drizzle's better-sqlite3 driver over node:sqlite (see ./sqlite.ts). This is
 * drizzle's own `drizzle({ client })` minus its top-level `import 'better-sqlite3'`,
 * which would need the native module at runtime; the session and the migrator
 * are drizzle's and only call the client methods the adapter provides.
 */
function drizzleOver(client: SqliteDatabase): Db {
  const dialect = new SQLiteSyncDialect();
  const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relational = { fullSchema: schema, schema: tables.tables, tableNamesMap: tables.tableNamesMap };
  // The session is typed for better-sqlite3's Database; the adapter has the subset it calls.
  const session = new BetterSQLiteSession(client as unknown as ConstructorParameters<typeof BetterSQLiteSession>[0], dialect, relational);
  const db = new BaseSQLiteDatabase('sync', dialect, session, relational) as unknown as Db;
  db.$client = client;
  return db;
}

/**
 * drizzle's migrator for this database. Its parameter type is the full better-sqlite3
 * database, which `Db` deliberately narrows (`$client`); the migrator only uses the session.
 */
export function migrateDb(db: Db, config: MigrationConfig): void {
  migrate(db as unknown as BetterSQLite3Database<typeof schema>, config);
}

export function openDb(file: string) {
  if (!MIGRATIONS) throw new Error('drizzle migrations folder not found');
  const sqlite = new SqliteDatabase(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzleOver(sqlite);
  migrateDb(db, { migrationsFolder: MIGRATIONS });
  return { db, sqlite, close: () => sqlite.close() };
}
