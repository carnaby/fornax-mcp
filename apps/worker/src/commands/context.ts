import { WorkerApi } from '../api.js';
import { ConfigError, readToken, readWorkerConfig, serverWarning, type WorkerConfig } from '../config.js';
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
};

export const apiFor = (ctx: Ctx, server: string, token: string): WorkerApi =>
  ctx.makeApi?.(server, token) ?? new WorkerApi({ server, token, onWarning: (m) => ctx.out(`warning: ${m}`) });

/** worker.yaml, the token and an API client; ConfigError with a hint when this PC is not paired. */
export function connect(ctx: Ctx): { config: WorkerConfig; api: WorkerApi } {
  const config = readWorkerConfig(ctx.paths);
  const token = readToken(ctx.paths);
  if (!token) throw new ConfigError(`no worker token in ${ctx.paths.tokenFile}; pair this PC first: fornax worker pair --server <url> --name <name>`);
  const warning = serverWarning(config.server);
  if (warning) ctx.out(warning);
  return { config, api: apiFor(ctx, config.server, token) };
}
