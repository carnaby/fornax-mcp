import { networkErrorOf } from '../api.js';
import type { Ctx } from '../commands/context.js';
import { InstallError } from './errors.js';

/**
 * GET `url`, read in chunks and stopped once it is clearly larger than the `size` the server announced (spec 05c 4,
 * 06d 3). `what` names the file in the errors ("worker bundle", "tray installer").
 */
export async function downloadBytes(ctx: Ctx, url: string, size: number, what: string): Promise<Buffer> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]);
  const limit = size + 1024 * 1024;
  let res: Response;
  try {
    res = await (ctx.fetch ?? fetch)(url, { signal });
  } catch (e) {
    throw networkErrorOf(e, signal);
  }
  if (!res.ok) throw new InstallError(`the server has no ${what} (HTTP ${res.status})`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > limit) throw new InstallError(`the ${what} is larger than the server announced`);
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw networkErrorOf(e, signal);
  }
  return Buffer.concat(chunks);
}
