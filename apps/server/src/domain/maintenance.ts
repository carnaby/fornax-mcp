import { and, count, eq, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, invites, jobs, jobTypes, tokens, uploads } from '../db/schema.js';
import type { RouteDeps } from '../http/deps.js';
import { deleteFiles } from './files.js';
import { expireLeases } from './queue.js';
import { workerOnline } from './worker-state.js';

export const TYPE_UNAVAILABLE = 'the worker has not offered this job type for too long';
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

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
  for (const row of orphanRows) await deps.store.remove(row.id);
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
  const unavailable = typeGone.length === 0
    ? 0
    : db
        .update(jobs)
        .set({ state: 'failed', error: TYPE_UNAVAILABLE, finishedAt: now, updatedAt: now })
        .where(and(eq(jobs.state, 'queued'), lt(jobs.createdAt, ago(now, r.unavailableTypeMs)), or(...typeGone)))
        .returning({ id: jobs.id })
        .all().length;

  const old = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.state, ['succeeded', 'failed', 'canceled']), lt(jobs.finishedAt, ago(now, r.finishedMs))))
    .all()
    .map((x) => x.id);
  if (old.length) {
    await deleteFiles(deps, db.select().from(files).where(inArray(files.jobId, old)).all());
    db.delete(jobs).where(inArray(jobs.id, old)).run();
  }

  const pendingTokens = db
    .delete(tokens)
    .where(and(eq(tokens.status, 'pending'), lt(tokens.createdAt, ago(now, r.pendingTokenMs))))
    .returning({ id: tokens.id })
    .all().length;

  return { leases, orphans: orphanRows.length, unavailable, finished: old.length, pendingTokens };
}

export function queueStatus(db: Db, now: Date) {
  const counts = db
    .select({ state: jobs.state, n: count() })
    .from(jobs)
    .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
    .where(inArray(jobs.state, ['queued', 'running']))
    .groupBy(jobs.state)
    .all();
  const running = db.select().from(jobs).where(eq(jobs.state, 'running')).get();
  return {
    queued: counts.find((c) => c.state === 'queued')?.n ?? 0,
    running: counts.find((c) => c.state === 'running')?.n ?? 0,
    worker: workerOnline(db, now),
    current: running ? { type: running.type, progress: running.progress, progress_message: running.progressMessage } : null,
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
