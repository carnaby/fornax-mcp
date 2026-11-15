import { realpathSync } from 'node:fs';
import { WorkerApi } from '../api.js';
import { ConfigError, readToken, readWorkerConfig, serverWarning, type WorkerConfig } from '../config.js';
import type { SwapDeps } from '../install/app.js';
import type { PathDeps } from '../install/path-entry.js';
import type { LeaseTimings } from '../lease/run.js';
import type { LoopOptions } from '../loop.js';
import type { Paths } from '../paths.js';

/** What every command gets: directories, output, the stop signal; tests replace the rest. */
export type Ctx = {
  paths: Paths;
  /** One line of output. */
  out: (line: string) => void;
  /** Raw output as it comes (a pack's setup); dropped when absent. */
  write?: (text: string) => void;
  signal: AbortSignal;
  makeApi?: (server: string, token: string) => WorkerApi;
  loopOptions?: Pick<LoopOptions, 'claimWaitS' | 'checkTimeoutMs' | 'backoffMs' | 'jobOptions'>;
  /** Copy text to the clipboard; the program used, or null. */
  clipboard?: (text: string) => string | null;
  /** Test seam: nvidia-smi as program and leading arguments (fornax doctor and the worker's card check). */
  nvidiaSmi?: string[];
  /** One line to stderr (fornax lease keeps stdout for its program); falls back to `out`. */
  err?: (line: string) => void;
  /** The environment for FORNAX_CLIENT_TOKEN and FORNAX_LEASE; process.env when absent. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the first line of standard input. */
  readStdin?: () => Promise<string>;
  /** Test seam: shorter clocks for fornax lease. */
  leaseTimings?: Partial<LeaseTimings>;
  /** Test seam: the running fornax.mjs (spec 05c 2: "the installed copy"). */
  script?: string;
  /** Test seam: how fornax install puts fornax on PATH. */
  pathDeps?: PathDeps;
  /** Test seam: the version this program is (default WORKER_VERSION). */
  currentVersion?: string;
  /** Test seam: fetch for fornax update's zip download (default globalThis.fetch). */
  fetch?: typeof fetch;
  /** Test seam: the renames of fornax update's swap of <data>/app. */
  swapDeps?: SwapDeps;
  /** Set by the CLI's main block: run `fornax worker` as the supervisor (spec 05c 5.1). Tests leave it unset. */
  supervise?: (args: string[]) => Promise<number>;
  /**
   * Called once the worker holds `<data>/worker.lock`, before anything else it does. Set by the CLI's main block only
   * for the child under the tray: its `started` event (spec 06 3.2) must not come from a worker that is refused.
   */
  onWorkerStarted?: () => void;
};

export const apiFor = (ctx: Ctx, server: string, token: string): WorkerApi =>
  ctx.makeApi?.(server, token) ?? new WorkerApi({ server, token, onWarning: (m) => ctx.out(`warning: ${m}`) });

/** The running fornax.mjs, resolved as the OS names it (the CLI is started as `node <it>`). */
export function runningScript(ctx: Ctx): string {
  if (ctx.script !== undefined) return ctx.script;
  try {
    return realpathSync.native(process.argv[1] ?? '');
  } catch {
    return process.argv[1] ?? '';
  }
}

/** worker.yaml, the token and an API client; ConfigError with a hint when this PC is not paired. */
export function connect(ctx: Ctx): { config: WorkerConfig; api: WorkerApi } {
  const config = readWorkerConfig(ctx.paths);
  const token = readToken(ctx.paths);
  if (!token) throw new ConfigError(`no worker token in ${ctx.paths.tokenFile}; pair this PC first: fornax worker pair --server <url> --name <name>`);
  const warning = serverWarning(config.server);
  if (warning) ctx.out(warning);
  return { config, api: apiFor(ctx, config.server, token) };
}
