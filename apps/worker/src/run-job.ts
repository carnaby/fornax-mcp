import type { Stats } from 'node:fs';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ClaimedJob, validateParams } from '@fornax/protocol';
import { isTransient, LeaseLostError, UploadFileError, type WorkerApi } from './api.js';
import { type CollectedOutputs, collectOutputs, LOG_NAME, OutputError, type OutputFile } from './outputs.js';
import { missingTools, type Pack } from './pack.js';
import { type JobDirs, jobDirs, type Paths } from './paths.js';
import { childEnv, KILL_GRACE_MS, logTail, type RunResult, runProcess } from './process.js';
import { expandArgv, TemplateError } from './template.js';

export const HEARTBEAT_MS = 30_000;
/** Job-level server calls wait this long between tries while the network is down (about 3 minutes in all). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000];
const RELEASE_TIMEOUT_MS = 10_000;
/** The id becomes a directory name. */
const JOB_ID = /^[0-9A-Za-z]{1,64}$/;

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
  return `${where} could not be read (${err.code ?? err.message})`;
}

type Stop = 'cancel' | 'lost' | 'shutdown';

/** Run the tool with a heartbeat every `heartbeatMs` carrying its progress; stop it on cancel, a lost lease or shutdown. */
async function runWithHeartbeat(
  job: ClaimedJob, argv: string[], dirs: JobDirs, pack: Pack, deps: JobDeps, say: (line: string) => void,
): Promise<{ stop: Stop | null; result: RunResult }> {
  const halt = new AbortController();
  let stop: Stop | null = null;
  const end = (why: Stop) => {
    if (stop) return;
    stop = why;
    halt.abort();
  };
  const onShutdown = () => end('shutdown');
  if (deps.signal?.aborted) end('shutdown');
  deps.signal?.addEventListener('abort', onShutdown, { once: true });

  const every = deps.heartbeatMs ?? HEARTBEAT_MS;
  let progress: number | null = 0;
  let message: string | null = null;
  let beating = true;
  let timer: NodeJS.Timeout | undefined;
  const beat = async () => {
    try {
      if ((await deps.api.heartbeat(job.id, job.lease, progress, message)).cancel) end('cancel');
    } catch (e) {
      if (e instanceof LeaseLostError) end('lost');
      else say(`heartbeat failed (${(e as Error).message}); the tool keeps running and the next heartbeat tries again`);
    }
    if (beating) timer = setTimeout(beat, every);
  };
  timer = setTimeout(beat, every);
  try {
    const result = await runProcess({
      argv,
      cwd: dirs.work,
      env: childEnv(process.env, { FORNAX_JOB_ID: job.id, FORNAX_OUT: dirs.out, FORNAX_WORK: dirs.work }),
      timeoutMs: pack.contract.max_runtime_s * 1000,
      signal: halt.signal,
      killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS,
      onProgress: (p) => {
        progress = p.progress;
        message = p.message;
      },
    });
    return { stop, result };
  } finally {
    beating = false;
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onShutdown);
  }
}

/** One claimed job, start to end. Never rejects: the result says what became of the job. */
export async function runJob(job: ClaimedJob, pack: Pack, deps: JobDeps): Promise<JobResult> {
  if (!JOB_ID.test(job.id)) return { outcome: 'lost', detail: 'the server sent a job id that cannot be a directory name' };
  const say = deps.log ?? (() => {});
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const call = <T>(fn: () => Promise<T>) => withRetry(fn, delays, deps.signal);
  const dirs = jobDirs(deps.paths, job.id);
  const logFile = join(dirs.root, LOG_NAME);

  const fail = async (error: string, permanent: boolean): Promise<JobResult> => {
    const state = await call(() => deps.api.fail(job.id, job.lease, error, permanent));
    return { outcome: state === 'failed' ? 'failed' : 'retry', detail: error };
  };
  const giveBack = async (outcome: 'released' | 'broken', detail: string): Promise<JobResult> => {
    try {
      // While stopping there is no time for retries; otherwise a short outage must not cost the client an attempt.
      if (deps.signal?.aborted) await deps.api.release(job.id, job.lease, AbortSignal.timeout(RELEASE_TIMEOUT_MS));
      else await call(() => deps.api.release(job.id, job.lease));
    } catch (e) {
      if (!(e instanceof LeaseLostError)) say(`could not give the job back (${(e as Error).message}); the server takes it back when its lease runs out`);
    }
    return { outcome, detail };
  };
  const uploadLog = async (log: string): Promise<void> => {
    try {
      await writeFile(logFile, log);
      await call(() => deps.api.uploadOutput(job.id, job.lease, LOG_NAME, 'log', logFile, deps.signal));
    } catch (e) {
      // A lost lease or a stop ends the job anyway; any other failure only costs the log.
      if (e instanceof LeaseLostError || deps.signal?.aborted) throw e;
      say(`the log could not be uploaded: ${(e as Error).message}`);
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
      await deps.api.uploadOutput(job.id, job.lease, f.name, 'output', f.path, deps.signal, f.size);
    } catch (e) {
      if (e instanceof UploadFileError) throw new OutputError(`out/${f.name} changed after the tool ended: ${e.message}`);
      throw e;
    }
  };

  try {
    await rm(dirs.root, { recursive: true, force: true });
    await Promise.all([mkdir(dirs.in, { recursive: true }), mkdir(dirs.out, { recursive: true }), mkdir(dirs.work, { recursive: true })]);

    // At once: confirms the claim to the server and learns about a cancel before any work.
    if ((await call(() => deps.api.heartbeat(job.id, job.lease, 0, null))).cancel) return { outcome: 'canceled', detail: 'canceled before it started' };

    const missing = missingTools(pack, deps.tools);
    if (missing.length) return await giveBack('broken', `tools missing in worker.yaml: ${missing.join(', ')}`);

    // The server checked the params against the contract it was offered; this PC may hold a newer version of the type.
    const params = validateParams(pack.contract.params, job.params);
    if (!params.ok) return await fail(`params do not match this type's current version: ${params.errors.join('; ')}`, true);

    const inputs: Record<string, string> = {};
    for (const input of job.inputs) {
      if (!Object.hasOwn(pack.contract.inputs, input.name)) return await fail(`input ${input.name} is not part of this type's current version`, true);
      const dest = join(dirs.in, inputFileName(input.name, input.file_name));
      await call(() => deps.api.downloadInput(job.id, job.lease, input, dest, deps.signal));
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

    const { stop, result: r } = await runWithHeartbeat(job, argv, dirs, pack, deps, say);
    // How the run was stopped comes first: on Windows a killed tool exits with taskkill's code 1, never a signal.
    if (stop === 'shutdown') return await giveBack('released', 'the worker is stopping');
    if (stop === 'cancel') return { outcome: 'canceled', detail: 'canceled by the client' };
    if (stop === 'lost') return { outcome: 'lost', detail: 'the job is no longer held by this worker' };
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
      try {
        for (const f of collected.files) await call(() => uploadOutput(f));
      } catch (e) {
        if (!(e instanceof OutputError)) throw e;
        await uploadLog(r.log);
        return await fail(e.message, true);
      }
      await uploadLog(r.log);
      await call(() => deps.api.complete(job.id, job.lease, collected.info));
      return { outcome: 'succeeded', detail: `${collected.files.length} output(s)` };
    }
    if (r.code === 3) return await giveBack('broken', `the tool reported a broken environment (exit code 3)${why}`);
    await uploadLog(r.log);
    if (r.code === 2) return await fail(`the tool refused the input (exit code 2)${why}`, true);
    return await fail(r.code === null ? `the tool was killed (${r.signal ?? 'signal'})${why}` : `the tool failed (exit code ${r.code})${why}`, false);
  } catch (e) {
    if (deps.signal?.aborted) return await giveBack('released', 'the worker is stopping');
    if (e instanceof LeaseLostError) return { outcome: 'lost', detail: e.message };
    const message = (e as Error).message;
    try {
      // A local problem (disk full) or an outage longer than the retries: one try to hand the job back as failed.
      const state = await deps.api.fail(job.id, job.lease, `worker error: ${message}`, false);
      return { outcome: state === 'failed' ? 'failed' : 'retry', detail: message };
    } catch {
      return { outcome: 'lost', detail: message };
    }
  } finally {
    try {
      await rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      // A leftover process may still hold a file; the next run of this id clears the directory first.
      say(`the job directory could not be removed: ${(e as Error).message}`);
    }
  }
}
