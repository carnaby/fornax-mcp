import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, count, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, invites, jobs, jobTypes, tokens, uploads, webhookDeliveries } from '../db/schema.js';
import type { RouteDeps } from '../http/deps.js';
import { deleteFiles } from './files.js';
import { finishJob } from './finish.js';
import { expireLeases } from './queue.js';
import { queuePaused } from './queue-control.js';
import { IDLE } from './queue-order.js';
import { workerOnline } from './worker-state.js';

export const TYPE_UNAVAILABLE = 'the worker has not offered this job type for too long';
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

/** A file without a row (or a partial upload) younger than this may be an upload whose row is about to be written. */
export const SWEEP_GRACE_MS = 3_600_000;

/**
 * Disk entries the database does not know: a file whose row was deleted while the file could not be (deleteFiles), a
 * file stored just before its row insert failed, a partial upload of a server that crashed. Only entries older than
 * SWEEP_GRACE_MS go.
 */
export async function sweepDisk(deps: RouteDeps, now: Date): Promise<{ removed: number; failed: number }> {
  const known = new Set(deps.db.select({ id: files.id }).from(files).all().map((r) => r.id));
  const cutoff = now.getTime() - SWEEP_GRACE_MS;
  let removed = 0;
  let failed = 0;
  const sweep = async (dir: string, wanted: (name: string) => boolean) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !wanted(e.name)) continue;
      const path = join(dir, e.name);
      try {
        if ((await stat(path)).mtimeMs >= cutoff) continue;
        await rm(path, { force: true });
        removed++;
      } catch {
        failed++;
      }
    }
  };
  await sweep(deps.store.root, (name) => !known.has(name));
  await sweep(deps.store.tmp, (name) => name.endsWith('.part'));
  return { removed, failed };
}

/** One pass of the periodic cleanup (spec 5, "Upratovanie"). Each step is independent and idempotent. */
export async function runMaintenance(deps: RouteDeps) {
  const { db, config } = deps;
  const now = deps.clock();
  const r = config.retention;

  const leases = expireLeases(db, now);

  // The rows go first, in one guarded statement: a file bound to a job meanwhile is no longer matched and keeps its disk file.
  const orphanRows = db
    .delete(files)
    .where(and(eq(files.kind, 'input'), isNull(files.jobId), lt(files.createdAt, ago(now, r.orphanUploadMs))))
    .returning({ id: files.id })
    .all();
  let diskErrors = 0;
  for (const row of orphanRows) {
    try {
      await deps.store.remove(row.id);
    } catch {
      // The row is gone; the disk sweep removes the file in a later pass.
      diskErrors++;
    }
  }
  db.delete(uploads).where(lt(uploads.expiresAt, now)).run();
  db.delete(invites).where(lt(invites.expiresAt, now)).run();

  const known = db.select({ name: jobTypes.name }).from(jobTypes).all().map((x) => x.name);
  const stale = db
    .select({ name: jobTypes.name })
    .from(jobTypes)
    .where(and(eq(jobTypes.offered, false), lt(jobTypes.lastOfferedAt, ago(now, r.unavailableTypeMs))))
    .all()
    .map((x) => x.name);
  // A queued job fails when its type was withdrawn (or never known) for the whole period and it waited that long.
  const typeGone = [stale.length ? inArray(jobs.type, stale) : undefined, known.length ? notInArray(jobs.type, known) : undefined].filter(
    (c) => c !== undefined,
  );
  const gone = typeGone.length === 0
    ? []
    : db.select().from(jobs).where(and(eq(jobs.state, 'queued'), lt(jobs.createdAt, ago(now, r.unavailableTypeMs)), or(...typeGone))).all();
  let unavailable = 0;
  for (const j of gone) if (finishJob(db, j, { state: 'failed', error: TYPE_UNAVAILABLE }, now)) unavailable++;

  const old = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.state, ['succeeded', 'failed', 'canceled']), lt(jobs.finishedAt, ago(now, r.finishedMs))))
    .all()
    .map((x) => x.id);
  if (old.length) {
    diskErrors += (await deleteFiles(deps, db.select().from(files).where(inArray(files.jobId, old)).all())).failed;
    db.delete(webhookDeliveries).where(inArray(webhookDeliveries.jobId, old)).run();
    db.delete(jobs).where(inArray(jobs.id, old)).run();
  }

  const pendingTokens = db
    .delete(tokens)
    .where(and(eq(tokens.status, 'pending'), lt(tokens.createdAt, ago(now, r.pendingTokenMs))))
    .returning({ id: tokens.id })
    .all().length;

  const swept = await sweepDisk(deps, now);
  diskErrors += swept.failed;

  return { leases, orphans: orphanRows.length, unavailable, finished: old.length, pendingTokens, swept: swept.removed, diskErrors };
}

/** The queue as every client sees it. The running job's message is its owner's free text: only the owner (viewer) gets it. */
export function queueStatus(db: Db, now: Date, viewer: string | null = null) {
  // Spec 07 § 2.2: idle jobs are counted apart; `queued` is what can start.
  const idle = sql<number>`${jobs.priority} = ${IDLE}`;
  const counts = db
    .select({ state: jobs.state, idle, n: count() })
    .from(jobs)
    .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
    .where(inArray(jobs.state, ['queued', 'running']))
    .groupBy(jobs.state, idle)
    .all();
  const sum = (state: string, isIdle: boolean) =>
    counts.filter((c) => c.state === state && Boolean(c.idle) === isIdle).reduce((total, c) => total + c.n, 0);
  const running = db.select().from(jobs).where(eq(jobs.state, 'running')).get();
  return {
    queued: sum('queued', false),
    idle: sum('queued', true),
    running: sum('running', false) + sum('running', true),
    paused: queuePaused(db),
    worker: workerOnline(db, now),
    current: running
      ? {
          type: running.type,
          progress: running.progress,
          progress_message: running.ownerTokenId === viewer ? running.progressMessage : null,
          // Spec 05a 2.4: since when it runs (a waiting job's note says so).
          started_at: running.startedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** For the worker: what waits, including jobs of types it does not offer. */
export function workerQueue(db: Db) {
  const s = queueStatus(db, new Date(0));
  const unavailable = db
    .select({ type: jobs.type, count: count() })
    .from(jobs)
    .leftJoin(jobTypes, eq(jobTypes.name, jobs.type))
    .where(and(eq(jobs.state, 'queued'), or(isNull(jobTypes.name), eq(jobTypes.offered, false))))
    .groupBy(jobs.type)
    .all();
  return { queued: s.queued, running: s.running, unavailable };
}
