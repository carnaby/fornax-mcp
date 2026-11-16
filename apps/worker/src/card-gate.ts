import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkerWaiting } from '@fornax/protocol';
import { ApiError, isTransient } from './api.js';
import { oneLine } from './checks.js';
import type { GpuReading } from './gpu.js';

/** Spec 05a 2.3: while the card is busy, measure again this often. */
export const CARD_POLL_MS = 10_000;
/** While waiting, the status goes out at least this often: it keeps the worker online (the server's limit is 90 s). */
export const STATUS_RESEND_MS = 30_000;

export type CardGateOptions = {
  maxUsedMib: number;
  measure: () => Promise<GpuReading>;
  /** PUT /api/worker/status. */
  report: (waiting: WorkerWaiting | null) => Promise<void>;
  out: (line: string) => void;
  signal: AbortSignal;
  pollMs?: number;
  resendMs?: number;
};

const waitingLine = (w: WorkerWaiting): string =>
  w.reason === 'gpu_busy'
    ? `waiting: ${w.used_mib} MiB of ${w.total_mib} MiB of the card in use by other programs, limit ${w.limit_mib} MiB; no job is taken`
    : `waiting: the card cannot be read (${w.error}), limit ${w.limit_mib} MiB; no job is taken`;

/** What one reading of the card means for the loop (spec 06c 2.1): an unreadable card also stops the type checks. */
export type CardState = { kind: 'free' } | { kind: 'busy' } | { kind: 'unreadable'; error: string };

/**
 * Before every claim (spec 05a 2.3): the card is measured. Above the limit, or when it cannot be read (closed on error:
 * the author set the limit to protect the PC), no job is taken, the server is told why, and the loop pauses
 * (`pause()`). One console line per change of state, not per measurement.
 */
export function cardGate(o: CardGateOptions): { check(): Promise<CardState>; pause(): Promise<void> } {
  const pollMs = o.pollMs ?? CARD_POLL_MS;
  const resendMs = o.resendMs ?? STATUS_RESEND_MS;
  /** What the console last heard: null at start, then 'free' or a reason. */
  let shown: 'free' | WorkerWaiting['reason'] | null = null;
  /** What the server was last told; null also while it was told nothing. */
  let told: WorkerWaiting | null = null;
  let toldAt = 0;
  let serverTakesStatus = true;

  const tell = async (waiting: WorkerWaiting | null): Promise<void> => {
    if (!serverTakesStatus) return;
    try {
      await o.report(waiting);
      told = waiting;
      toldAt = Date.now();
    } catch (e) {
      // An older server (404) or one that refuses this status (any other 4xx but a refused token): sending it again
      // would only be refused again, and the worker must go on checking the card rather than end.
      if (e instanceof ApiError && e.status === 404) {
        serverTakesStatus = false;
        o.out('the server does not take the worker status (it is older than this worker): the card is still checked, but queue_status cannot say why jobs wait');
        return;
      }
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403) {
        serverTakesStatus = false;
        o.out(`the server refused the worker status (${e.status}: ${oneLine(e.message, 200)}): the card is still checked, but queue_status cannot say why jobs wait`);
        return;
      }
      // Unreachable now: the next pass tells it again.
      if (isTransient(e)) return;
      throw e;
    }
  };

  return {
    async check(): Promise<CardState> {
      const r = await o.measure();
      if (r.ok && r.used_mib <= o.maxUsedMib) {
        if (shown !== null && shown !== 'free') o.out(`the card is free again (${r.used_mib} of ${r.total_mib} MiB in use, limit ${o.maxUsedMib} MiB); taking jobs`);
        shown = 'free';
        if (told !== null) await tell(null);
        return { kind: 'free' };
      }
      const waiting: WorkerWaiting = r.ok
        ? { reason: 'gpu_busy', used_mib: r.used_mib, total_mib: r.total_mib, limit_mib: o.maxUsedMib }
        : { reason: 'gpu_unreadable', error: oneLine(r.error, 200), limit_mib: o.maxUsedMib };
      if (shown !== waiting.reason) o.out(waitingLine(waiting));
      shown = waiting.reason;
      if (told === null || told.reason !== waiting.reason || Date.now() - toldAt >= resendMs) await tell(waiting);
      return r.ok ? { kind: 'busy' } : { kind: 'unreadable', error: oneLine(r.error, 200) };
    },
    async pause(): Promise<void> {
      try {
        await sleep(pollMs, undefined, { signal: o.signal });
      } catch {
        // Stopped: the loop ends.
      }
    },
  };
}
