import { setTimeout as sleep } from 'node:timers/promises';
import type { ClaimedJob } from '@fornax/protocol';
import { ApiError, isTransient, type WorkerApi } from './api.js';
import { cardGate } from './card-gate.js';
import { oneLine, packsSignature, preparePacks } from './checks.js';
import type { GpuReading } from './gpu.js';
import { loadPacks, type Pack, type PackProblem } from './pack.js';
import type { Paths } from './paths.js';
import { RESTART_EXIT } from './restart.js';
import { type JobApi, type JobDeps, runJob } from './run-job.js';

export const CLAIM_WAIT_S = 25;
/** Spec 7.4 step 2: pauses while the server is unreachable grow from 1 s to at most 60 s. */
export const BACKOFF = { baseMs: 1000, maxMs: 60_000 };

/** Spec 06c 2.2: one job type as the tray sees it. */
export type TypeState = { name: string; state: 'offered' | 'waiting' | 'unavailable'; reason?: string };
/** The reason of every type while the worker cannot read the card. */
export const WAITING_FOR_CARD = 'waiting for the card';
/** A reason in a types report: one line, at most this many characters. */
const REASON_MAX = 300;

const byName = (types: TypeState[]): TypeState[] => [...types].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const unavailable = (p: PackProblem): TypeState => ({ name: p.name, state: 'unavailable', reason: oneLine(p.reason, REASON_MAX) });
const waitingFor = (name: string): TypeState => ({ name, state: 'waiting', reason: WAITING_FOR_CARD });

export type LoopApi = JobApi & Pick<WorkerApi, 'announce' | 'claim' | 'status'>;

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
  jobOptions?: Pick<JobDeps, 'heartbeatMs' | 'killGraceMs' | 'retryDelaysMs' | 'leaseMs' | 'leaseMarginMs'>;
  /** Spec 05a 2: check the card before each claim (only when worker.yaml sets gpu.max_used_mib). */
  gpu?: { maxUsedMib: number; measure: () => Promise<GpuReading>; pollMs?: number; resendMs?: number };
  /** Spec 05c 5.2: asked at the start of every round (between jobs); true ends the loop with RESTART_EXIT. Not with `once`. */
  restart?: () => boolean;
  /** Spec 06c 2.2: the types and their state, sorted by name, whenever the list changes (the tray's `types` event). */
  onTypes?: (types: TypeState[]) => void;
};

/** `fornax worker` (spec 7.4): announce the ready types, claim, run, repeat. Returns the process exit code. */
export async function runWorker(o: LoopOptions): Promise<number> {
  const backoff = o.backoffMs ?? BACKOFF;
  let offered = new Map<string, Pack>();
  let signature = '';
  const gate = o.gpu ? cardGate({ ...o.gpu, report: (w) => o.api.status(w, o.signal), out: o.out, signal: o.signal }) : null;
  /** The types after their last check; null before the first one. */
  let checked: TypeState[] | null = null;
  /** The card could not be read at its last measurement (only with the card check). */
  let cardMissing = false;
  /** The last list given to onTypes, as JSON: the same list is not reported twice. */
  let toldTypes = '';

  /** Spec 06c 2.2: while the card cannot be read, every type that could run waits for it. */
  const waitingTypes = (): TypeState[] => {
    if (checked) return checked.map((t) => (t.state === 'offered' ? waitingFor(t.name) : t));
    const { packs, failed } = loadPacks(o.paths.typesDir);
    return byName([...packs.map((p) => waitingFor(p.contract.name)), ...failed.map(unavailable)]);
  };

  const tellTypes = () => {
    if (!o.onTypes) return;
    const types = cardMissing ? waitingTypes() : (checked ?? []);
    const json = JSON.stringify(types);
    if (json === toldTypes) return;
    toldTypes = json;
    o.onTypes(types);
  };

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
    for (const p of problems) o.out(`not offered: type pack ${p.name}: ${p.reason}`);
    offered = new Map(ready.map((p) => [p.contract.name, p]));
    checked = byName([...ready.map((p): TypeState => ({ name: p.contract.name, state: 'offered' })), ...problems.map(unavailable)]);
    tellTypes();
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
      const reason = `a job found its environment broken: fix it, check it with fornax doctor ${job.type}, then restart the worker`;
      checked = (checked ?? []).map((t): TypeState => (t.name === job.type ? { name: t.name, state: 'unavailable', reason } : t));
      tellTypes();
      await announce();
    }
  };

  try {
    // Spec 06c 2.1: with the card check the types are checked only with a card that can be read (below); without it now.
    if (!gate) await refresh();
    while (!o.signal.aborted) {
      if (!o.once && o.restart?.()) return RESTART_EXIT;
      if (gate) {
        // A card held by programs outside the queue keeps every job waiting (no claim: --once waits too).
        const card = await gate.check();
        if (card.kind === 'unreadable') {
          if (checked === null && !cardMissing) o.out(`waiting for the card before checking the types (${card.error})`);
          cardMissing = true;
          tellTypes();
          await gate.pause();
          continue;
        }
        // The card is there (at the start, or back): the types are checked with it before the next claim.
        if (cardMissing || checked === null) {
          cardMissing = false;
          await refresh();
          if (o.signal.aborted) break;
        }
        if (card.kind === 'busy') {
          await gate.pause();
          continue;
        }
      }
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
