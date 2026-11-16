import { createHash } from 'node:crypto';
import { FORNAX_VERSION, type OperatorJob, type OperatorQueue, PRIORITIES } from '@fornax/protocol';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, jobs, tokens, workerState } from '../db/schema.js';
import { isOffered } from './job-types.js';
import type { JobRow } from './jobs.js';
import { queuePaused, queuePausedAt } from './queue-control.js';
import { workerOnline } from './worker-state.js';

/** Spec 06 2.3: how many finished jobs the operator sees, newest first. */
export const OPERATOR_FINISHED = 50;

const iso = (d: Date | null) => d?.toISOString() ?? null;
type Seen = Omit<OperatorJob, 'result_url'>;

/**
 * Spec 06 2.3: the whole queue for the worker's operator: every owner's jobs, the waiting ones in queue order. `change`
 * covers what the operator sees except what moves by itself (worker.last_seen with every worker request, an unfinished
 * job's result link with the clock); with them in it a long-poll would answer at once every time.
 */
export function operatorQueue(db: Db, now: Date, resultUrlOf: (job: JobRow) => string): OperatorQueue {
  const running = db.select().from(jobs).where(eq(jobs.state, 'running')).orderBy(asc(jobs.startedAt), asc(jobs.id)).limit(1).all();
  const queued = db.select().from(jobs).where(eq(jobs.state, 'queued')).orderBy(asc(jobs.queueRank), asc(jobs.id)).all();
  const finished = db
    .select()
    .from(jobs)
    .where(inArray(jobs.state, ['succeeded', 'failed', 'canceled']))
    .orderBy(desc(jobs.finishedAt), desc(jobs.id))
    .limit(OPERATOR_FINISHED)
    .all();
  const rows = [...running, ...queued, ...finished];
  const owners = new Map(db.select({ id: tokens.id, name: tokens.name }).from(tokens).all().map((r) => [r.id, r.name]));
  const fileIds = [...new Set(rows.flatMap((j) => Object.values(j.inputs)))];
  const names = new Map(
    fileIds.length ? db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, fileIds)).all().map((f) => [f.id, f.name]) : [],
  );

  const seen = (j: JobRow): Seen => ({
    id: j.id,
    type: j.type,
    owner: owners.get(j.ownerTokenId) ?? null,
    state: j.state,
    label: typeof j.params.label === 'string' ? j.params.label : null,
    group: j.group,
    priority: PRIORITIES[j.priority] ?? 'normal',
    inputs: Object.fromEntries(Object.entries(j.inputs).map(([name, id]) => [name, names.get(id) ?? null])),
    attempts: j.attempts,
    type_unavailable: j.state === 'queued' && !isOffered(db, j.type),
    run_after: j.state === 'queued' && j.runAfter.getTime() > now.getTime() ? j.runAfter.toISOString() : null,
    created_at: j.createdAt.toISOString(),
    started_at: iso(j.startedAt),
    finished_at: iso(j.finishedAt),
    progress: j.progress,
    progress_message: j.progressMessage,
    error: j.error,
  });

  const version = db.select({ version: workerState.version }).from(workerState).where(eq(workerState.id, 1)).get()?.version ?? null;
  const body = {
    paused: queuePaused(db),
    paused_at: iso(queuePausedAt(db)),
    worker: { ...workerOnline(db, now), version },
    running: running[0] ? seen(running[0]) : null,
    queued: queued.map(seen),
    finished: finished.map(seen),
  };
  const change = createHash('sha256')
    .update(JSON.stringify({ ...body, worker: { ...body.worker, last_seen: null } }))
    .digest('hex')
    .slice(0, 16);
  const linked = (v: Seen, row: JobRow): OperatorJob => ({ ...v, result_url: resultUrlOf(row) });
  return {
    server_time: now.toISOString(),
    server_version: FORNAX_VERSION,
    change,
    paused: body.paused,
    paused_at: body.paused_at,
    worker: body.worker,
    running: running[0] && body.running ? linked(body.running, running[0]) : null,
    queued: queued.map((row, i) => linked(body.queued[i]!, row)),
    finished: finished.map((row, i) => linked(body.finished[i]!, row)),
  };
}
