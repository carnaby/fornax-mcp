import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';
import { jobs, tokens } from '../src/db/schema.js';
import { SqliteDatabase } from '../src/db/sqlite.js';
import { useTestDb } from './helpers.js';

const t = useTestDb();

test('migrations create the tables', () => {
  const now = new Date(1_000);
  t.db.insert(tokens).values({ id: 'a', name: 'alice', role: 'client', hash: 'h', fingerprint: 'AAAA-AAAA', status: 'pending', createdAt: now }).run();
  const row = t.db.select().from(tokens).where(eq(tokens.id, 'a')).get();
  expect(row?.createdAt.getTime()).toBe(1_000);
  expect(row?.status).toBe('pending');
});

/** A database as 0.8.0 left it: 0007 not applied, its new columns absent, a job saved with priority 0 (then: low). */
function databaseOf080(file: string): void {
  const opened = openDb(file);
  try {
    const now = new Date(1_000);
    opened.db.insert(jobs).values({
      id: 'J1', ownerTokenId: 'a', type: 'render', params: {}, inputs: {}, priority: 0, group: null, callbackUrl: null, state: 'queued',
      attempts: 0, envReleases: 0, runAfter: now, leaseId: null, leaseExpiresAt: null, confirmedAt: null, progress: null, progressMessage: null,
      error: null, manifest: null, createdAt: now, startedAt: null, finishedAt: null, updatedAt: now, queueRank: 1, stoppedLeaseId: null, idleSince: null,
    }).run();
  } finally {
    opened.close();
  }
  const raw = new SqliteDatabase(file);
  try {
    raw.exec('DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)');
    raw.exec('ALTER TABLE jobs DROP COLUMN stopped_lease_id');
    raw.exec('ALTER TABLE jobs DROP COLUMN idle_since');
  } finally {
    raw.close();
  }
}

/** Opens the database, hands it over, always closes it. */
function withDb<T>(file: string, fn: (db: ReturnType<typeof openDb>['db']) => T): T {
  const opened = openDb(file);
  try {
    return fn(opened.db);
  } finally {
    opened.close();
  }
}

test('0007: a low job of 0.8.0 becomes normal once; an idle job later stays idle (spec 07 § 2.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fornax-0007-'));
  try {
    const file = join(dir, 'fornax.db');
    databaseOf080(file);
    withDb(file, (db) => {
      expect(db.select().from(jobs).where(eq(jobs.id, 'J1')).get()).toMatchObject({ priority: 1, stoppedLeaseId: null, idleSince: null });
      db.update(jobs).set({ priority: 0 }).where(eq(jobs.id, 'J1')).run();
    });
    withDb(file, (db) => expect(db.select().from(jobs).where(eq(jobs.id, 'J1')).get()?.priority).toBe(0));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
