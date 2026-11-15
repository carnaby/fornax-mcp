import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { networkErrorOf } from '../api.js';
import { ConfigError, readWorkerConfig } from '../config.js';
import { bundleVersion, cleanLeftovers, isInstalledCopy, isWorkerDir, removeDir, swapDir } from '../install/app.js';
import { compareVersions, fetchBundleInfo } from '../install/bundle-info.js';
import { InstallError } from '../install/errors.js';
import { syncPacksUnderLock } from '../install/packs.js';
import { extractWorkerZip } from '../install/unzip.js';
import { writeRestartRequest } from '../restart.js';
import { WORKER_VERSION } from '../version.js';
import { type Ctx, runningScript } from './context.js';
import { localTools } from './types.js';

/** `fornax update [--force] [--server <url>]` (spec 05c 4): the server's worker into <data>/app, packs, restart request. */
export async function updateCommand(ctx: Ctx, opts: { force: boolean; server?: string }): Promise<number> {
  const script = runningScript(ctx);
  if (!isInstalledCopy(script, ctx.paths)) {
    ctx.out(`fornax is not installed: run node ${script} install`);
    return 1;
  }
  let server = opts.server;
  if (server === undefined) {
    try {
      server = readWorkerConfig(ctx.paths).server;
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      ctx.out(`${e.message}; or name the server: fornax update --server <url>`);
      return 1;
    }
  }
  const base = server.replace(/\/+$/, '');
  const current = ctx.currentVersion ?? WORKER_VERSION;
  const info = await fetchBundleInfo(base, ctx.signal);
  if (info.version === current && !opts.force) {
    ctx.out(`fornax ${current} is current`);
    return 0;
  }

  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]);
  let res: Response;
  try {
    res = await (ctx.fetch ?? fetch)(`${base}/downloads/fornax-worker.zip`, { signal });
  } catch (e) {
    throw networkErrorOf(e, signal);
  }
  if (!res.ok) throw new InstallError(`the server has no worker bundle (HTTP ${res.status})`);
  const announced = Number(res.headers.get('content-length') ?? info.size);
  if (announced > info.size + 1024 * 1024) throw new InstallError('the worker bundle is larger than the server announced');
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length !== info.size || createHash('sha256').update(zip).digest('hex') !== info.sha256) {
    throw new InstallError('the download does not match the checksum the server announced; nothing was changed (run fornax update again)');
  }

  const app = ctx.paths.appDir;
  mkdirSync(ctx.paths.dataDir, { recursive: true });
  cleanLeftovers(ctx.paths);
  try {
    extractWorkerZip(zip, `${app}.new`);
    if (!isWorkerDir(`${app}.new`) || bundleVersion(`${app}.new`) !== info.version) {
      throw new InstallError(`the download is not the fornax worker ${info.version} the server announced; nothing was changed`);
    }
    swapDir(`${app}.new`, app);
  } catch (e) {
    removeDir(`${app}.new`);
    throw e;
  }
  ctx.out(
    info.version === current
      ? `reinstalled fornax ${current}`
      : `updated fornax ${current} → ${info.version}${compareVersions(info.version, current) < 0 ? ' (older; the server offers it)' : ''}`,
  );
  const packs = await syncPacksUnderLock(ctx.paths, { shippedDir: join(app, 'types'), tools: localTools(ctx), out: ctx.out, write: ctx.write, signal: ctx.signal });
  if (packs === 'worker-running') {
    writeRestartRequest(ctx.paths, info.version);
    ctx.out('the worker restarts between jobs (after its running job, if any)');
  }
  return 0;
}
