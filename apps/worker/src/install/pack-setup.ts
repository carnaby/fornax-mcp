import { ConfigError } from '../config.js';
import type { Pack } from '../pack.js';
import { LogBuffer, logTail, runProcess } from '../process.js';
import { Redactor } from '../redact.js';
import { expandArgv } from '../template.js';
import { type SecretDirs, setupEnv } from '../tool-env.js';

/** A pack's setup (venv, packages, models) may take this long. */
export const SETUP_TIMEOUT_MS = 2 * 3_600_000;

/** Run a pack's setup in its installed directory; null when it worked (or it has none), else why not, in one line. */
export async function runPackSetup(o: {
  pack: Pack;
  dir: string;
  tools: Record<string, string>;
  dirs: SecretDirs;
  signal: AbortSignal;
  write?: (text: string) => void;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!o.pack.impl.setup) return null;
  let prepared: { env: Record<string, string>; values: string[] };
  try {
    prepared = setupEnv(o.dirs, o.pack);
  } catch (e) {
    // Spec 08: a damaged secret file stops the setup; the message names the file, never its content.
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  // Spec 08 § 4.3: one redactor per stream (interleaved streams would split a value), and the failure reason is taken
  // from the masked text, never from the raw log.
  const masked = new LogBuffer();
  const emit = (text: string) => {
    masked.push(text);
    o.write?.(text);
  };
  const redactors = { stdout: new Redactor(prepared.values, emit), stderr: new Redactor(prepared.values, emit) };
  const r = await runProcess({
    argv: expandArgv(o.pack.impl.setup, { pack: o.dir, tools: o.tools }),
    cwd: o.dir,
    env: prepared.env,
    timeoutMs: o.timeoutMs ?? SETUP_TIMEOUT_MS,
    signal: o.signal,
    onOutput: (text, stream) => redactors[stream].push(text),
  });
  redactors.stdout.flush();
  redactors.stderr.flush();
  if (r.code === 0) return null;
  const why = r.spawnError ?? (r.timedOut ? 'it ran too long' : r.canceled ? 'interrupted' : `exit code ${r.code ?? r.signal}`);
  const tail = logTail(masked.toString());
  return `${why}${tail ? `: ${tail}` : ''}`;
}
