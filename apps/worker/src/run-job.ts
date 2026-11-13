import type { Stats } from 'node:fs';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ClaimedJob, validateParams } from '@fornax/protocol';
import { ApiError, InputMismatchError, isTransient, LeaseLostError, LocalFileError, NetworkError, UploadFileError, type WorkerApi } from './api.js';
import { type CollectedOutputs, collectOutputs, LOG_NAME, OutputError, type OutputFile } from './outputs.js';
import { missingTools, type Pack } from './pack.js';
import { jobDirs, type Paths } from './paths.js';
import { childEnv, KILL_GRACE_MS, logTail, runProcess } from './process.js';
import { expandArgv, TemplateError } from './template.js';

export const HEARTBEAT_MS = 30_000;
/** One heartbeat may take this long; a half-open connection must not hold the next ones up for minutes. */
export const HEARTBEAT_TIMEOUT_MS = 20_000;
/** Job-level server calls wait this long between tries while the network is down (about 3 minutes in all). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000];
const RELEASE_TIMEOUT_MS = 10_000;
/** The id becomes a directory name. */
const JOB_ID = /^[0-9A-Za-z]{1,64}$/;
const RM_RETRIES = { maxRetries: 10, retryDelay: 200 };

export type JobApi = Pick<WorkerApi, 'heartbeat' | 'fail' | 'release' | 'downloadInput' | 'uploadOutput' | 'complete'>;

export type JobDeps = {
  api: JobApi;
  paths: Paths;
  tools: Record<string, string>;
  /** Worker shutdown (Ctrl+C, SIGTERM): the job is stopped and released. */
  signal?: AbortSignal;
  /** Progress notes for the console; never params or file contents. */
  log?: (line: string) => void;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  killGraceMs?: number;
  retryDelaysMs?: number[];
};

export type JobOutcome = 'succeeded' | 'retry' | 'failed' | 'canceled' | 'released' | 'broken' | 'lost';
export type JobResult = { outcome: JobOutcome; detail: string };

/** in/<input name><ext>: the extension of the client's file name, lower-cased, kept only when it is plain. */
export function inputFileName(inputName: string, clientFileName: string): string {
  const ext = extname(clientFileName).toLowerCase().slice(1);
  return /^[a-z0-9]{1,10}$/.test(ext) ? `${inputName}.${ext}` : inputName;
}

async function withRetry<T>(fn: () => Promise<T>, delays: number[], signal?: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || i >= delays.length || signal?.aborted) throw e;
      await sleep(delays[i]!, undefined, signal ? { signal } : undefined);
    }
  }
}

/**
 * Why collectOutputs threw something other than an OutputError (EISDIR, EACCES), naming the file when the error does.
 * The error code stands in for the message, which would carry this PC's absolute path to the client.
 */
function unreadableOutputs(e: unknown, outDir: string): string {
  const err = e as NodeJS.ErrnoException;
  const rel = err.path ? relative(outDir, err.path).split(sep).join('/') : '';
  const where = rel && rel !== '..' && !rel.startsWith('../') ? `out/${rel}` : 'out/';
  return `${where} could not be read (${err.code ?? err.name})`;
}

/**
 * What the server may be told about an unexpected error. Errors of the API client carry messages made without local
 * paths; for anything else (a file-system error names absolute paths of this PC) only its code or class.
 */
function describeError(e: unknown): string {
  const ours = [ApiError, NetworkError, InputMismatchError, LocalFileError, UploadFileError].some((c) => e instanceof c);
  if (ours) return (e as Error).message;
  const err = e as NodeJS.ErrnoException | undefined;
  return err?.code ?? (err instanceof Error ? err.name : 'unknown error');
}

/** A heartbeat every `every` ms carrying the latest progress, until stopped. `beat` never rejects. */
function startHeartbeat(every: number, beat: (progress: number | null, message: string | null) => Promise<void>) {
  let progress: number | null = 0;
  let message: string | null = null;
  let on = true;
  let current: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    current = beat(progress, message).then(() => {
      if (on) timer = setTimeout(tick, every);
    });
  };
  timer = setTimeout(tick, every);
  return {
    report(p: number | null, m: string | null): void {
      progress = p;
      message = m;
    },
    /** No further heartbeats; resolves once the one in flight, if any, has its answer. */
    async stop(): Promise<void> {
      on = false;
      clearTimeout(timer);
      await current;
    },
  };
}

type Stop = 'cancel' | 'lost' | 'shutdown';

/**
 * One claimed job, start to end. Never rejects: the result says what became of the job.
 * Heartbeats keep the lease from the claim until the last call (complete, fail or release), downloads and uploads
 * included. A cancel or a lost lease seen in a heartbeat, or the worker stopping, aborts whatever runs at that moment:
 * the tool (its whole tree), a download, an upload or a pause between retries.
 */
export async function runJob(job: ClaimedJob, pack: Pack, deps: JobDeps): Promise<JobResult> {
  if (!JOB_ID.test(job.id)) return { outcome: 'lost', detail: 'the server sent a job id that cannot be a directory name' };
  const say = deps.log ?? (() => {});
  const dirs = jobDirs(deps.paths, job.id);
  const logFile = join(dirs.root, LOG_NAME);

  // Aborted on cancel, a lost lease or shutdown; every transfer, retry pause and the tool itself listen to it.
  const halt = new AbortController();
  const signal = halt.signal;
  const state: { stop: Stop | null } = { stop: null };
  const end = (why: Stop) => {
    if (state.stop) return;
    state.stop = why;
    halt.abort();
  };
  const onShutdown = () => end('shutdown');
  deps.signal?.addEventListener('abort', onShutdown, { once: true });
  if (deps.signal?.aborted) end('shutdown');

  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const call = <T>(fn: () => Promise<T>) => withRetry(fn, delays, signal);
  const beatSignal = () => AbortSignal.any([signal, AbortSignal.timeout(deps.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS)]);
  let beats: ReturnType<typeof startHeartbeat> | null = null;
  /** Stop the heartbeats: none may cross the job's last call. */
  const quiet = async () => {
    const b = beats;
    beats = null;
    await b?.stop();
  };

  const release = async (outcome: 'released' | 'broken', detail: string): Promise<JobResult> => {
    try {
      // While stopping there is no time for retries; otherwise a short outage must not cost the client an attempt.
      if (deps.signal?.aborted) await deps.api.release(job.id, job.lease, AbortSignal.timeout(RELEASE_TIMEOUT_MS));
      else await call(() => deps.api.release(job.id, job.lease));
    } catch (e) {
      if (!(e instanceof LeaseLostError)) say(`could not give the job back (${describeError(e)}); the server takes it back when its lease runs out`);
    }
    return { outcome, detail };
  };
  const stopped = async (why: Stop): Promise<JobResult> => {
    await quiet();
    if (why === 'shutdown') return await release('released', 'the worker is stopping');
    if (why === 'cancel') return { outcome: 'canceled', detail: 'canceled by the client' };
    return { outcome: 'lost', detail: 'the job is no longer held by this worker' };
  };
  /** Before the last call: the heartbeats end, and a stop they saw meanwhile wins. */
  const settle = async (): Promise<JobResult | null> => {
    await quiet();
    return state.stop ? await stopped(state.stop) : null;
  };
  const fail = async (error: string, permanent: boolean): Promise<JobResult> => {
    const s = await settle();
    if (s) return s;
    const st = await call(() => deps.api.fail(job.id, job.lease, error, permanent));
    return { outcome: st === 'failed' ? 'failed' : 'retry', detail: error };
  };
  const giveBack = async (outcome: 'released' | 'broken', detail: string): Promise<JobResult> => (await settle()) ?? (await release(outcome, detail));
  const uploadLog = async (log: string): Promise<void> => {
    try {
      await writeFile(logFile, log);
      await call(() => deps.api.uploadOutput(job.id, job.lease, LOG_NAME, 'log', logFile, signal));
    } catch (e) {
      // A lost lease or a stop ends the job anyway; any other failure only costs the log.
      if (e instanceof LeaseLostError || signal.aborted) throw e;
      say(`the log could not be uploaded (${describeError(e)})`);
    }
  };
  /**
   * One output, checked again right before each try: a detached grandchild may have changed it since it was collected.
   * It must still be a plain file (not a link) of the collected size, and exactly that many bytes are sent.
   */
  const uploadOutput = async (f: OutputFile): Promise<void> => {
    let st: Stats | null = null;
    try {
      st = await lstat(f.path);
    } catch {
      // Gone or unreadable: reported below like any other change.
    }
    if (!st?.isFile() || st.size !== f.size) {
      throw new OutputError(`out/${f.name} changed after the tool ended (it is no longer a plain file of ${f.size} bytes)`);
    }
    try {
      await deps.api.uploadOutput(job.id, job.lease, f.name, 'output', f.path, signal, f.size);
    } catch (e) {
      if (e instanceof UploadFileError) throw new OutputError(`out/${f.name} changed after the tool ended: ${e.message}`);
      throw e;
    }
  };

  try {
    await rm(dirs.root, { recursive: true, force: true, ...RM_RETRIES });
    await Promise.all([mkdir(dirs.in, { recursive: true }), mkdir(dirs.out, { recursive: true }), mkdir(dirs.work, { recursive: true })]);

    // At once: confirms the claim to the server and learns about a cancel before any work.
    if ((await call(() => deps.api.heartbeat(job.id, job.lease, 0, null, beatSignal()))).cancel) return { outcome: 'canceled', detail: 'canceled before it started' };
    beats = startHeartbeat(deps.heartbeatMs ?? HEARTBEAT_MS, async (progress, message) => {
      try {
        if ((await deps.api.heartbeat(job.id, job.lease, progress, message, beatSignal())).cancel) end('cancel');
      } catch (e) {
        if (e instanceof LeaseLostError) end('lost');
        else if (!signal.aborted) say(`heartbeat failed (${describeError(e)}); the job goes on and the next heartbeat tries again`);
      }
    });

    const missing = missingTools(pack, deps.tools);
    if (missing.length) return await giveBack('broken', `tools missing in worker.yaml: ${missing.join(', ')}`);

    // The server checked the params against the contract it was offered; this PC may hold a newer version of the type.
    const params = validateParams(pack.contract.params, job.params);
    if (!params.ok) return await fail(`params do not match this type's current version: ${params.errors.join('; ')}`, true);

    const inputs: Record<string, string> = {};
    for (const input of job.inputs) {
      if (!Object.hasOwn(pack.contract.inputs, input.name)) return await fail(`input ${input.name} is not part of this type's current version`, true);
      const dest = join(dirs.in, inputFileName(input.name, input.file_name));
      await call(() => deps.api.downloadInput(job.id, job.lease, input, dest, signal));
      inputs[input.name] = dest;
    }
    for (const [name, spec] of Object.entries(pack.contract.inputs)) {
      if (spec.required && !Object.hasOwn(inputs, name)) return await fail(`input ${name} is required by this type's current version`, true);
    }

    const paramsJson = join(dirs.work, 'params.json');
    await writeFile(paramsJson, JSON.stringify(params.value, null, 2));
    let argv: string[];
    try {
      argv = expandArgv(pack.impl.run, { pack: pack.dir, tools: deps.tools, job: { params: params.value, paramsJson, inputs, out: dirs.out, work: dirs.work } });
    } catch (e) {
      if (e instanceof TemplateError) return await fail(`cannot build the command: ${e.message}`, true);
      throw e;
    }

    const r = await runProcess({
      argv,
      cwd: dirs.work,
      env: childEnv(process.env, { FORNAX_JOB_ID: job.id, FORNAX_OUT: dirs.out, FORNAX_WORK: dirs.work }),
      timeoutMs: pack.contract.max_runtime_s * 1000,
      signal,
      killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS,
      onProgress: (p) => beats?.report(p.progress, p.message),
    });
    // How the run was stopped comes first: on Windows a killed tool exits with taskkill's code 1, never a signal.
    if (state.stop) return await stopped(state.stop);
    if (r.timedOut) {
      await uploadLog(r.log);
      return await fail(`stopped after max_runtime (${pack.contract.max_runtime_s} s)`, false);
    }
    // A tool that cannot be started at all is a broken environment, like exit code 3.
    if (r.spawnError) return await giveBack('broken', `could not start ${argv[0]}: ${r.spawnError}`);
    const tail = logTail(r.log);
    const why = tail ? `: ${tail}` : '';
    if (r.code === 0) {
      let collected: CollectedOutputs;
      try {
        collected = await collectOutputs(dirs.out);
      } catch (e) {
        // Whatever is wrong in out/ is the tool's doing: a retry would find the same.
        await uploadLog(r.log);
        return await fail(e instanceof OutputError ? e.message : unreadableOutputs(e, dirs.out), true);
      }
      beats?.report(1, 'uploading outputs');
      try {
        for (const f of collected.files) await call(() => uploadOutput(f));
      } catch (e) {
        if (!(e instanceof OutputError)) throw e;
        await uploadLog(r.log);
        return await fail(e.message, true);
      }
      await uploadLog(r.log);
      const s = await settle();
      if (s) return s;
      await call(() => deps.api.complete(job.id, job.lease, collected.info));
      return { outcome: 'succeeded', detail: `${collected.files.length} output(s)` };
    }
    if (r.code === 3) return await giveBack('broken', `the tool reported a broken environment (exit code 3)${why}`);
    await uploadLog(r.log);
    if (r.code === 2) return await fail(`the tool refused the input (exit code 2)${why}`, true);
    return await fail(r.code === null ? `the tool was killed (${r.signal ?? 'signal'})${why}` : `the tool failed (exit code ${r.code})${why}`, false);
  } catch (e) {
    // A transfer or a pause aborted by a stop: the stop decides.
    if (state.stop) return await stopped(state.stop);
    await quiet();
    if (e instanceof LeaseLostError) return { outcome: 'lost', detail: e.message };
    const reason = describeError(e);
    try {
      // A local problem (disk full) or an outage longer than the retries: one try to hand the job back as failed.
      const st = await deps.api.fail(job.id, job.lease, `worker error: ${reason}`, false);
      return { outcome: st === 'failed' ? 'failed' : 'retry', detail: reason };
    } catch {
      return { outcome: 'lost', detail: reason };
    }
  } finally {
    await quiet();
    deps.signal?.removeEventListener('abort', onShutdown);
    try {
      await rm(dirs.root, { recursive: true, force: true, ...RM_RETRIES });
    } catch (e) {
      // A leftover process may still hold a file; the next run of this id clears the directory first.
      say(`the job directory could not be removed (${describeError(e)})`);
    }
  }
}
