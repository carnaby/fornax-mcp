import { lockWorker, sweepJobs } from '../instance.js';
import { runWorker } from '../loop.js';
import { connect, type Ctx } from './context.js';

/** `fornax worker [--once]`: one per PC, under `<data>/worker.lock`. */
export async function workerCommand(ctx: Ctx, once: boolean): Promise<number> {
  const { config, api } = connect(ctx);
  const lock = lockWorker(ctx.paths);
  if (!('release' in lock)) {
    ctx.out(
      `another fornax worker runs on this PC${lock.heldBy ? ` (pid ${lock.heldBy})` : ''}; stop it first (if none runs, remove ${lock.file})`,
    );
    return 1;
  }
  // A hard quit (second Ctrl+C) exits without unwinding: the lock goes with the process.
  const onExit = () => lock.release();
  process.once('exit', onExit);
  try {
    const swept = await sweepJobs(ctx.paths);
    if (swept.failed) {
      ctx.out(`${swept.failed} leftover job ${swept.failed === 1 ? 'directory' : 'directories'} could not be removed (${swept.code}); a process of an earlier run may still hold a file`);
    }
    return await runWorker({ api, paths: ctx.paths, tools: config.tools, out: ctx.out, signal: ctx.signal, once, ...ctx.loopOptions });
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
