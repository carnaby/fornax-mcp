import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundleVersion, cleanLeftovers, copyWorkerDir, isInstalledCopy, isWorkerDir, swapDir } from '../install/app.js';
import { syncPacksUnderLock } from '../install/packs.js';
import { addToPath } from '../install/path-entry.js';
import { type Ctx, runningScript } from './context.js';
import { localTools } from './types.js';

/** `fornax install` (spec 05c 3): the unzipped worker to <data>/app, fornax on PATH, the built-in packs up to date. */
export async function installCommand(ctx: Ctx): Promise<number> {
  const script = runningScript(ctx);
  const source = dirname(script);
  const app = ctx.paths.appDir;
  if (!isWorkerDir(source)) {
    ctx.out(`${source} is not an unzipped fornax worker (fornax.mjs, fornax, fornax.cmd, VERSION and types/); download it from <server>/downloads/fornax-worker.zip and unzip it`);
    return 1;
  }
  const version = bundleVersion(source)!;
  if (isInstalledCopy(script, ctx.paths)) ctx.out(`fornax ${version} is installed in ${app}`);
  else {
    mkdirSync(ctx.paths.dataDir, { recursive: true });
    cleanLeftovers(ctx.paths);
    copyWorkerDir(source, `${app}.new`);
    swapDir(`${app}.new`, app);
    ctx.out(`installed fornax ${version} in ${app}`);
  }
  for (const line of addToPath(app, ctx.pathDeps)) ctx.out(line);
  const packs = await syncPacksUnderLock(ctx.paths, { shippedDir: join(app, 'types'), tools: localTools(ctx), out: ctx.out, write: ctx.write, signal: ctx.signal });
  if (packs === 'worker-running') ctx.out('a fornax worker runs: it brings the installed types up to date when it starts from the installed copy');
  ctx.out(
    existsSync(ctx.paths.configFile)
      ? 'next: fornax worker (in a new terminal); the folder you unzipped can be deleted'
      : 'next: fornax worker pair --server <url> --name <name> (in a new terminal)',
  );
  return 0;
}
