import type { Pack } from '../pack.js';
import { childEnv, logTail, runProcess } from '../process.js';
import { expandArgv } from '../template.js';

/** A pack's setup (venv, packages, models) may take this long. */
export const SETUP_TIMEOUT_MS = 2 * 3_600_000;

/** Run a pack's setup in its installed directory; null when it worked (or it has none), else why not, in one line. */
export async function runPackSetup(o: {
  pack: Pack;
  dir: string;
  tools: Record<string, string>;
  signal: AbortSignal;
  write?: (text: string) => void;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!o.pack.impl.setup) return null;
  const r = await runProcess({
    argv: expandArgv(o.pack.impl.setup, { pack: o.dir, tools: o.tools }),
    cwd: o.dir,
    env: childEnv(process.env, {}),
    timeoutMs: o.timeoutMs ?? SETUP_TIMEOUT_MS,
    signal: o.signal,
    onOutput: o.write,
  });
  if (r.code === 0) return null;
  const why = r.spawnError ?? (r.timedOut ? 'it ran too long' : r.canceled ? 'interrupted' : `exit code ${r.code ?? r.signal}`);
  const tail = logTail(r.log);
  return `${why}${tail ? `: ${tail}` : ''}`;
}
