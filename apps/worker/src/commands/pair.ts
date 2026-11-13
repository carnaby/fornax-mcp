import { fingerprint, generateToken, TOKEN_NAME } from '@fornax/protocol';
import { ApiError, NetworkError } from '../api.js';
import { checkWritableConfig, readToken, saveServer, saveToken, serverUrlProblem, serverWarning } from '../config.js';
import { apiFor, type Ctx } from './context.js';

/**
 * `fornax worker pair` (spec 9): the token is made here and never leaves this PC except as its hash on the server.
 * Its first call registers it as pending against the admin's invite; it is saved only then.
 */
export async function pair(ctx: Ctx, opts: { server: string; name: string; force: boolean }): Promise<number> {
  const problem = serverUrlProblem(opts.server);
  if (problem) {
    ctx.out(`--server: ${problem}; use the URL printed by fornax-admin tokens invite`);
    return 2;
  }
  const server = new URL(opts.server).href.replace(/\/+$/, '');
  if (!TOKEN_NAME.test(opts.name)) {
    ctx.out('--name must be 1-24 characters a-z or 0-9: the name the admin invited');
    return 2;
  }
  // --force first: a damaged token file must not block replacing it.
  if (!opts.force && readToken(ctx.paths)) {
    ctx.out(`this PC is already paired (${ctx.paths.tokenFile}); add --force to replace its token`);
    return 1;
  }
  // Registering uses up the invite: whatever could fail on this PC is checked first.
  checkWritableConfig(ctx.paths);
  const warning = serverWarning(server);
  if (warning) ctx.out(warning);
  const token = generateToken(opts.name);
  try {
    await apiFor(ctx, server, token).ping(ctx.signal);
    // Let in at once: this is not the server that holds the invite (or it does not check worker tokens).
    ctx.out('this server did not register the token; is the URL right?');
    return 1;
  } catch (e) {
    if (ctx.signal.aborted) {
      ctx.out('stopped; nothing was saved');
      return 1;
    }
    if (e instanceof ApiError && e.status === 401) {
      ctx.out(`the server did not accept the token: there is no open invite for ${opts.name}.`);
      ctx.out(`On the server run: fornax-admin tokens invite ${opts.name} --worker`);
      return 1;
    }
    if (e instanceof NetworkError) {
      ctx.out(e.message);
      return 1;
    }
    if (e instanceof ApiError && e.status === 403 && e.code !== 'pending') {
      ctx.out(`the server refused the token (${e.message}); nothing was saved`);
      return 1;
    }
    // 403 "pending" is the expected answer: the token is registered and waits for approval.
    if (!(e instanceof ApiError && e.status === 403)) throw e;
  }
  // The server first: a failed token write must not leave a replaced token next to the old server.
  saveServer(ctx.paths, server);
  saveToken(ctx.paths, token);
  ctx.out(`Token saved to ${ctx.paths.tokenFile}.`);
  ctx.out(`Fingerprint: ${fingerprint(token)}`);
  ctx.out(`On the server compare the fingerprint, then run: fornax-admin tokens approve ${opts.name}`);
  return 0;
}
