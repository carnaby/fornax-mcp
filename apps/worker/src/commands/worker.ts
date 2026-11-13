import { runWorker } from '../loop.js';
import { connect, type Ctx } from './context.js';

/** `fornax worker [--once]`. */
export async function workerCommand(ctx: Ctx, once: boolean): Promise<number> {
  const { config, api } = connect(ctx);
  return runWorker({ api, paths: ctx.paths, tools: config.tools, out: ctx.out, signal: ctx.signal, once, ...ctx.loopOptions });
}

/** `fornax worker queue`: what waits, including jobs of types this worker does not offer. */
export async function queueCommand(ctx: Ctx): Promise<number> {
  const { api } = connect(ctx);
  const q = await api.queue();
  ctx.out(`queued ${q.queued}, running ${q.running}`);
  for (const u of q.unavailable) ctx.out(`waiting for a type this worker does not offer: ${u.type} (${u.count})`);
  return 0;
}
