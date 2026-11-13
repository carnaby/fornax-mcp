import { statSync } from 'node:fs';
import { ApiError, NetworkError } from '../api.js';
import { checkPack, findTool } from '../checks.js';
import { ConfigError, readToken, readWorkerConfig, serverWarning, type WorkerConfig } from '../config.js';
import { loadPacks } from '../pack.js';
import { apiFor, type Ctx } from './context.js';

/** `fornax doctor [type]`: configuration, server and token, tools, and each pack's check. Exit 0 only when all is well. */
export async function doctor(ctx: Ctx, only?: string): Promise<number> {
  let ok = true;
  const line = (good: boolean, text: string) => {
    if (!good) ok = false;
    ctx.out(`${good ? 'ok  ' : 'FAIL'}  ${text}`);
  };
  /** Worth fixing, but the worker runs. */
  const warn = (text: string) => ctx.out(`WARN  ${text}`);

  let config: WorkerConfig | null = null;
  try {
    config = readWorkerConfig(ctx.paths);
    line(true, `config ${ctx.paths.configFile}`);
    const warning = serverWarning(config.server);
    if (warning) warn(warning.replace(/^warning: /, ''));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    line(false, e.message);
  }
  let token: string | null = null;
  try {
    token = readToken(ctx.paths);
    if (!token) line(false, `no worker token in ${ctx.paths.tokenFile}; pair with fornax worker pair`);
    // Linux: the token file is the worker's password. (Windows relies on the profile's ACL, not checked here.)
    else if (process.platform !== 'win32') {
      const mode = statSync(ctx.paths.tokenFile).mode & 0o777;
      if (mode & 0o077) warn(`token file ${ctx.paths.tokenFile} can be read or changed by other users (mode ${mode.toString(8).padStart(4, '0')}); run chmod 600 ${ctx.paths.tokenFile}`);
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    line(false, e.message);
  }
  if (config && token) {
    try {
      await apiFor(ctx, config.server, token).ping();
      line(true, `server ${config.server}: token active`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) line(false, `server ${config.server}: the token waits for approval (${e.message})`);
      else if (e instanceof ApiError && e.status === 401) line(false, `server ${config.server}: the token is refused (revoked, replaced or never registered)`);
      else if (e instanceof NetworkError) line(false, `server ${config.server}: unreachable (${e.message})`);
      else throw e;
    }
  }

  const tools = config?.tools ?? {};
  for (const [name, path] of Object.entries(tools)) {
    const found = findTool(path);
    line(found !== null, `tool ${name}: ${found ?? `${path} was not found`}`);
  }

  const { packs, errors } = loadPacks(ctx.paths.typesDir);
  const mine = (msg: string) => only === undefined || msg.startsWith(`type pack ${only}:`);
  for (const e of errors.filter(mine)) line(false, e);
  const selected = only === undefined ? packs : packs.filter((p) => p.contract.name === only);
  if (only !== undefined && !selected.length && !errors.some(mine)) line(false, `type ${only} is not installed in ${ctx.paths.typesDir}`);
  if (only === undefined && !packs.length && !errors.length) line(false, `no type packs in ${ctx.paths.typesDir}; see fornax types install and fornax types add`);
  for (const p of selected) {
    const problem = await checkPack(p, tools, { signal: ctx.signal, timeoutMs: ctx.loopOptions?.checkTimeoutMs });
    line(problem === null, `type ${p.contract.name} v${p.contract.version}${problem ? `: ${problem}` : ''}`);
  }
  return ok ? 0 : 1;
}
