import { jobTypeContract } from '@fornax/protocol';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';
import { files, jobInputs, jobs, jobTypes, tokens } from '../src/db/schema.js';
import { SqliteDatabase } from '../src/db/sqlite.js';
import { renderContract } from './fixtures.js';
import { useTestDb } from './helpers.js';

const t = useTestDb();

test('migrations create the tables', () => {
  const now = new Date(1_000);
  t.db.insert(tokens).values({ id: 'a', name: 'alice', role: 'client', hash: 'h', fingerprint: 'AAAA-AAAA', status: 'pending', createdAt: now }).run();
  const row = t.db.select().from(tokens).where(eq(tokens.id, 'a')).get();
  expect(row?.createdAt.getTime()).toBe(1_000);
  expect(row?.status).toBe('pending');
});

/** A database as 0.8.0 left it: 0007–0010 not applied, their new columns and table absent, a job saved with priority 0 (then: low). */
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
    raw.exec('DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 4)');
    raw.exec('ALTER TABLE jobs DROP COLUMN stopped_lease_id');
    raw.exec('ALTER TABLE jobs DROP COLUMN idle_since');
    raw.exec('ALTER TABLE jobs DROP COLUMN agent');
    raw.exec('ALTER TABLE job_types DROP COLUMN environment');
    raw.exec('DROP TABLE job_inputs');
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

test('0007 and 0008: a low job of 0.8.0 becomes normal once and has no agent; an idle job later stays idle (spec 07 § 2.1, spec 09 § 2.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fornax-0007-'));
  try {
    const file = join(dir, 'fornax.db');
    databaseOf080(file);
    withDb(file, (db) => {
      expect(db.select().from(jobs).where(eq(jobs.id, 'J1')).get()).toMatchObject({ priority: 1, stoppedLeaseId: null, idleSince: null, agent: null });
      db.update(jobs).set({ priority: 0 }).where(eq(jobs.id, 'J1')).run();
    });
    withDb(file, (db) => expect(db.select().from(jobs).where(eq(jobs.id, 'J1')).get()?.priority).toBe(0));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('0009: a type stored before 0.14.1 has no environment (spec 12 § 3.2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fornax-0009-'));
  try {
    const file = join(dir, 'fornax.db');
    databaseOf080(file);
    withDb(file, (db) => {
      db.insert(jobTypes).values({ name: 'render', contract: jobTypeContract.parse(renderContract), contractHash: 'h', offered: true, lastOfferedAt: new Date(1_000) }).run();
      expect(db.select().from(jobTypes).get()?.environment).toBeNull();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('0010: inputs of 0.14 move from files.job_id to job_inputs; outputs keep their job (spec 14 § 2.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fornax-0010-'));
  try {
    const file = join(dir, 'fornax.db');
    const opened = openDb(file);
    try {
      const at = new Date(1_000);
      const row = { ownerTokenId: 'a', size: 1, sha256: 's', mime: 'application/octet-stream', meta: null, createdAt: at };
      opened.db.insert(files).values([
        { ...row, id: 'F1', kind: 'input', jobId: 'J1', name: 'scene.blend' },
        { ...row, id: 'F2', kind: 'input', jobId: null, name: 'unused.blend' },
        { ...row, id: 'F3', kind: 'output', jobId: 'J1', name: 'frame_0001.png' },
      ]).run();
    } finally {
      opened.close();
    }
    const raw = new SqliteDatabase(file);
    try {
      raw.exec('DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1)');
      raw.exec('DROP TABLE job_inputs');
    } finally {
      raw.close();
    }
    withDb(file, (db) => {
      expect(db.select().from(jobInputs).all()).toEqual([{ jobId: 'J1', fileId: 'F1' }]);
      expect(db.select({ id: files.id, jobId: files.jobId }).from(files).all().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'F1', jobId: null }, { id: 'F2', jobId: null }, { id: 'F3', jobId: 'J1' },
      ]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
