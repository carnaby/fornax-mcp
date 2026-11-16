import { dirname, join } from 'node:path';
import { readGpu } from '../gpu.js';
import { isInstalledCopy } from '../install/app.js';
import { errorName, syncShippedPacks } from '../install/packs.js';
import { lockWorker, sweepJobs } from '../instance.js';
import { runWorker } from '../loop.js';
import { restartCheck } from '../restart.js';
import { WORKER_VERSION } from '../version.js';
import { connect, type Ctx, runningScript } from './context.js';

/** `fornax worker [--once]` (the real worker, run by the supervisor as `worker --child`): one per PC, under `<data>/worker.lock`. */
export async function workerCommand(ctx: Ctx, once: boolean, opts: { child?: boolean; syncPacks?: typeof syncShippedPacks } = {}): Promise<number> {
  const { config, api } = connect(ctx);
  const lock = lockWorker(ctx.paths);
  if (!('release' in lock)) {
    ctx.out(
      `another fornax worker runs on this PC${lock.heldBy ? ` (pid ${lock.heldBy})` : ''}; stop it first (if none runs, remove ${lock.file})`,
    );
    return 1;
  }
  ctx.onWorkerStarted?.();
  // A hard quit (second Ctrl+C) exits without unwinding: the lock goes with the process.
  const onExit = () => lock.release();
  process.once('exit', onExit);
  try {
    const swept = await sweepJobs(ctx.paths);
    if (swept.failed) {
      ctx.out(`${swept.failed} leftover job ${swept.failed === 1 ? 'directory' : 'directories'} could not be removed (${swept.code}); a process of an earlier run may still hold a file`);
    }
    const script = runningScript(ctx);
    const installed = isInstalledCopy(script, ctx.paths);
    // Spec 05c 4.4: the installed copy brings the installed built-in packs up to its own before the first claim.
    if (installed) {
      try {
        await (opts.syncPacks ?? syncShippedPacks)({ shippedDir: join(ctx.paths.appDir, 'types'), typesDir: ctx.paths.typesDir, tools: config.tools, out: ctx.out, write: ctx.write, signal: ctx.signal });
      } catch (e) {
        // Cut short by a stop (Ctrl+C): the worker ends right after, nothing to warn about.
        if (!ctx.signal.aborted) ctx.out(`WARN  the installed types could not be brought up to date (${errorName(e)}); the worker starts with them as they are`);
      }
    }
    const restart = opts.child ? restartCheck(ctx.paths, { version: ctx.currentVersion ?? WORKER_VERSION, installed, runsFrom: dirname(script), out: ctx.out }) : undefined;
    const limit = config.gpu.maxUsedMib;
    const gpu = limit === null ? undefined : { maxUsedMib: limit, measure: () => readGpu({ command: ctx.nvidiaSmi }) };
    if (gpu) ctx.out(`the card is checked before each job: no job while more than ${limit} MiB of it are in use`);
    return await runWorker({ api, paths: ctx.paths, tools: config.tools, out: ctx.out, signal: ctx.signal, once, gpu, restart, onTypes: ctx.onTypes, ...ctx.loopOptions });
  } finally {
    process.off('exit', onExit);
    lock.release();
  }
}

/** `fornax worker queue`: what waits, including jobs of types this worker does not offer. */
export async function queueCommand(ctx: Ctx): Promise<number> {
  const { api } = connect(ctx);
  const q = await api.queue();
  ctx.out(`queued ${q.queued}, running ${q.running}`);
  for (const u of q.unavailable) ctx.out(`waiting for a type this worker does not offer: ${u.type} (${u.count})`);
  return 0;
}
