import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { workerState } from '../db/schema.js';

/** A worker heartbeats every 30 s and long-polls for at most 30 s, so 90 s of silence means it is gone. */
export const WORKER_ONLINE_MS = 90_000;

export function touchWorker(db: Db, input: { tokenId: string; hostname: string; version: string | null }, now: Date): void {
  const values = { tokenId: input.tokenId, hostname: input.hostname, version: input.version, lastSeenAt: now };
  db.insert(workerState).values({ id: 1, ...values }).onConflictDoUpdate({ target: workerState.id, set: values }).run();
}

export function workerOnline(db: Db, now: Date): { online: boolean; last_seen: string | null } {
  const row = db.select().from(workerState).where(eq(workerState.id, 1)).get();
  if (!row) return { online: false, last_seen: null };
  return { online: now.getTime() - row.lastSeenAt.getTime() <= WORKER_ONLINE_MS, last_seen: row.lastSeenAt.toISOString() };
}
