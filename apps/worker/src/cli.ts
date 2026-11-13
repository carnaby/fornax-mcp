#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiError, NetworkError } from './api.js';
import type { Ctx } from './commands/context.js';
import { doctor } from './commands/doctor.js';
import { pair } from './commands/pair.js';
import { typesAdd, typesInstall, typesList } from './commands/types.js';
import { queueCommand, workerCommand } from './commands/worker.js';
import { ConfigError } from './config.js';
import { PackError } from './pack.js';
import { resolvePaths } from './paths.js';

export const USAGE = [
  'usage: fornax worker pair --server <url> --name <name> [--force]',
  '       fornax worker [--once]',
  '       fornax worker queue',
  '       fornax doctor [type]',
  '       fornax types list',
  '       fornax types install <name> [--from <dir>]',
  '       fornax types add <name>',
].join('\n');

type Flags = { server?: string; name?: string; force?: boolean; from?: string; once?: boolean; help?: boolean };

/** Parse and dispatch. 0 done, 1 failed (the message says why), 2 usage. */
export async function runCli(argv: string[], ctx: Ctx): Promise<number> {
  let flags: Flags;
  let words: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        server: { type: 'string' },
        name: { type: 'string' },
        force: { type: 'boolean' },
        from: { type: 'string' },
        once: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    flags = parsed.values;
    words = parsed.positionals;
  } catch (e) {
    ctx.out((e as Error).message);
    ctx.out(USAGE);
    return 2;
  }
  if (flags.help) {
    ctx.out(USAGE);
    return 0;
  }
  /** Exactly `n` words, and no flag the command does not take (a typo must not silently change the meaning). */
  const shape = (n: number, ...allowed: (keyof Flags)[]) => words.length === n && Object.keys(flags).every((k) => allowed.includes(k as keyof Flags));
  const [group, sub, arg] = words;
  try {
    if (group === 'worker' && sub === 'pair' && shape(2, 'server', 'name', 'force') && flags.server && flags.name) {
      return await pair(ctx, { server: flags.server, name: flags.name, force: flags.force === true });
    }
    if (group === 'worker' && sub === undefined && shape(1, 'once')) return await workerCommand(ctx, flags.once === true);
    if (group === 'worker' && sub === 'queue' && shape(2)) return await queueCommand(ctx);
    if (group === 'doctor' && (shape(1) || shape(2))) return await doctor(ctx, sub);
    if (group === 'types' && sub === 'list' && shape(2)) return await typesList(ctx);
    if (group === 'types' && sub === 'install' && arg !== undefined && shape(3, 'from')) return await typesInstall(ctx, arg, flags.from);
    if (group === 'types' && sub === 'add' && arg !== undefined && shape(3)) return await typesAdd(ctx, arg);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof PackError || e instanceof NetworkError || e instanceof ApiError) {
      ctx.out(e.message);
      return 1;
    }
    // Anything else may carry local paths or tool output in its message: only its class and code are shown.
    const code = (e as NodeJS.ErrnoException).code;
    ctx.out(`unexpected error: ${e instanceof Error ? e.constructor.name : typeof e}${typeof code === 'string' ? ` (${code})` : ''}`);
    return 1;
  }
  ctx.out(USAGE);
  return 2;
}

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const stop = new AbortController();
  let signals = 0;
  const onSignal = () => {
    // The second Ctrl+C does not wait for the job to be given back.
    if (++signals > 1) process.exit(130);
    process.stderr.write('stopping: the running job is stopped and given back (Ctrl+C again quits at once)\n');
    stop.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const ctx: Ctx = { paths: resolvePaths(), out: (l) => console.log(l), write: (t) => process.stdout.write(t), signal: stop.signal };
  process.exitCode = await runCli(process.argv.slice(2), ctx);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}
