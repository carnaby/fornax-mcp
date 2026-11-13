import { setTimeout as sleep } from 'node:timers/promises';
import type { ClaimedJob } from '@fornax/protocol';
import { ApiError, isTransient, type WorkerApi } from './api.js';
import { packsSignature, preparePacks } from './checks.js';
import type { Pack } from './pack.js';
import type { Paths } from './paths.js';
import { type JobApi, type JobDeps, runJob } from './run-job.js';

export const CLAIM_WAIT_S = 25;
/** Spec 7.4 step 2: pauses while the server is unreachable grow from 1 s to at most 60 s. */
export const BACKOFF = { baseMs: 1000, maxMs: 60_000 };

export type LoopApi = JobApi & Pick<WorkerApi, 'announce' | 'claim'>;

export type LoopOptions = {
  api: LoopApi;
  paths: Paths;
  tools: Record<string, string>;
  out: (line: string) => void;
  /** Ctrl+C / SIGTERM: the running job is stopped and released, then the loop ends. */
  signal: AbortSignal;
  /** One claim (with its wait), the job if one came, then return. */
  once?: boolean;
  claimWaitS?: number;
  backoffMs?: { baseMs: number; maxMs: number };
  checkTimeoutMs?: number;
  jobOptions?: Pick<JobDeps, 'heartbeatMs' | 'killGraceMs' | 'retryDelaysMs'>;
};

/** `fornax worker` (spec 7.4): announce the ready types, claim, run, repeat. Returns the process exit code. */
export async function runWorker(o: LoopOptions): Promise<number> {
  const backoff = o.backoffMs ?? BACKOFF;
  let offered = new Map<string, Pack>();
  let signature = '';

  /** Retry what failed for network reasons, pausing longer each time, until it works or the worker stops. */
  const retrying = async <T>(fn: () => Promise<T>): Promise<T> => {
    let delay = backoff.baseMs;
    let down = false;
    for (;;) {
      try {
        const r = await fn();
        if (down) o.out('the server is reachable again');
        return r;
      } catch (e) {
        if (o.signal.aborted || !isTransient(e)) throw e;
        if (!down) o.out(`the server is unreachable (${(e as Error).message}); retrying, at most every ${backoff.maxMs / 1000} s`);
        down = true;
        await sleep(delay, undefined, { signal: o.signal });
        delay = Math.min(delay * 2, backoff.maxMs);
      }
    }
  };

  const announce = async () => {
    const names = await retrying(() => o.api.announce([...offered.values()].map((p) => p.contract)));
    o.out(names.length ? `offering: ${names.join(', ')}` : 'offering no job types; fornax doctor shows why');
  };

  const refresh = async () => {
    signature = packsSignature(o.paths.typesDir);
    const { ready, problems } = await preparePacks(o.paths.typesDir, o.tools, { timeoutMs: o.checkTimeoutMs, signal: o.signal });
    // Shutdown during the checks leaves some unchecked: never announce that reduced set (types are not withdrawn on stop).
    if (o.signal.aborted) return;
    for (const p of problems) o.out(`not offered: ${p}`);
    offered = new Map(ready.map((p) => [p.contract.name, p]));
    await announce();
  };

  const handle = async (job: ClaimedJob) => {
    const pack = offered.get(job.type);
    if (!pack) {
      o.out(`job ${job.id}: type ${job.type} is not offered here; giving it back`);
      await o.api.release(job.id, job.lease).catch(() => undefined);
      return;
    }
    o.out(`job ${job.id}: ${job.type}, attempt ${job.attempt}`);
    const r = await runJob(job, pack, {
      api: o.api, paths: o.paths, tools: o.tools, signal: o.signal, log: (l) => o.out(`job ${job.id}: ${l}`), ...o.jobOptions,
    });
    // The detail of a failure may hold tool output or local paths: only the outcome (and the output count) is printed.
    o.out(`job ${job.id}: ${r.outcome}${r.outcome === 'succeeded' ? ` (${r.detail})` : ''}`);
    if (r.outcome === 'broken') {
      offered.delete(job.type);
      o.out(`type ${job.type} is no longer offered: fix its environment, check it with fornax doctor ${job.type}, then restart the worker`);
      await announce();
    }
  };

  try {
    await refresh();
    while (!o.signal.aborted) {
      if (packsSignature(o.paths.typesDir) !== signature) await refresh();
      const job = await retrying(() => o.api.claim(o.claimWaitS ?? CLAIM_WAIT_S, o.signal));
      if (job) await handle(job);
      if (o.once) break;
    }
    return 0;
  } catch (e) {
    if (o.signal.aborted) return 0;
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      o.out(
        e.status === 403
          ? `this worker token waits for approval (${e.message}); approve it on the server with fornax-admin tokens approve <name>`
          : 'the server does not accept this worker token (revoked, replaced by a newer one, or never registered); pair again with fornax worker pair',
      );
      return 1;
    }
    throw e;
  }
}
