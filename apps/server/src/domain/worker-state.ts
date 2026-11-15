import type { WorkerWaiting } from '@fornax/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { workerState } from '../db/schema.js';
import { oneLine } from './queue.js';

/** A worker heartbeats every 5 s (30 s before 0.4.1) and long-polls for at most 30 s, so 90 s of silence means it is gone. */
export const WORKER_ONLINE_MS = 90_000;

/** Spec 05a 2.4: what clients see of the worker's reason to wait, with a ready sentence. */
export type WaitingView = { reason: WorkerWaiting['reason']; message: string; used_mib?: number; total_mib?: number; limit_mib: number };
export type WorkerView = { online: boolean; last_seen: string | null; waiting: WaitingView | null };

export function waitingView(w: WorkerWaiting): WaitingView {
  if (w.reason === 'gpu_busy') {
    return {
      reason: w.reason,
      message: `waiting: ${w.used_mib} MiB of ${w.total_mib} MiB of the card in use by other programs, limit ${w.limit_mib} MiB`,
      used_mib: w.used_mib,
      total_mib: w.total_mib,
      limit_mib: w.limit_mib,
    };
  }
  return {
    reason: w.reason,
    // The worker's error text inside a sentence: one line, no control characters.
    message: `waiting: the card cannot be read (${oneLine(w.error, 200) ?? 'unknown error'}), limit ${w.limit_mib} MiB`,
    limit_mib: w.limit_mib,
  };
}

export function touchWorker(db: Db, input: { tokenId: string; hostname: string; version: string | null }, now: Date): void {
  const values = { tokenId: input.tokenId, hostname: input.hostname, version: input.version, lastSeenAt: now };
  // `waiting` is not in `values`: any request of the worker keeps the reason it last reported.
  db.insert(workerState).values({ id: 1, ...values }).onConflictDoUpdate({ target: workerState.id, set: values }).run();
}

/** The worker's last status (PUT /api/worker/status); a claim clears it. The row exists: touchWorker ran first. */
export function setWorkerWaiting(db: Db, waiting: WorkerWaiting | null): void {
  db.update(workerState).set({ waiting }).where(eq(workerState.id, 1)).run();
}

/** Whether the worker is online, and its reason to wait only while it is (a stopped worker's last reason is stale). */
export function workerOnline(db: Db, now: Date): WorkerView {
  const row = db.select().from(workerState).where(eq(workerState.id, 1)).get();
  if (!row) return { online: false, last_seen: null, waiting: null };
  const online = now.getTime() - row.lastSeenAt.getTime() <= WORKER_ONLINE_MS;
  return { online, last_seen: row.lastSeenAt.toISOString(), waiting: online && row.waiting ? waitingView(row.waiting) : null };
}
