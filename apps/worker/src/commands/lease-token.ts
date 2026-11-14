import { createInterface } from 'node:readline';
import { parseToken } from '@fornax/protocol';
import { ApiError, NetworkError } from '../api.js';
import { ClientApi } from '../client-api.js';
import { readWorkerConfig, saveClientToken } from '../config.js';
import type { Ctx } from './context.js';

/** The first line of standard input: a token is pasted or piped, never an argument that stays in the shell history. */
export async function readStdinLine(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const rl = createInterface({ input, terminal: false });
  try {
    for await (const line of rl) return line;
    return '';
  } finally {
    rl.close();
  }
}

/** `fornax lease token` (spec 05a 4.3): read a client token from stdin, check it on the server, store it. 0 stored, 1 not. */
export async function leaseToken(ctx: Ctx): Promise<number> {
  const say = ctx.err ?? ctx.out;
  const config = readWorkerConfig(ctx.paths);
  if (!ctx.readStdin && process.stdin.isTTY) say('paste the client token and press Enter');
  const token = (await (ctx.readStdin ?? readStdinLine)()).trim();
  if (!parseToken(token)) {
    say('that is not a Fornax token (fornax-<name>-…); nothing was saved');
    return 1;
  }
  let me: { name: string; role: string };
  try {
    me = await new ClientApi({ server: config.server, token }).whoami(ctx.signal);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      say(`this token waits for approval (${e.message}); approve it on the server, then run fornax lease token again`);
      return 1;
    }
    if (e instanceof ApiError) {
      say('the server refused this token as a client token (a worker token, revoked, or unknown); nothing was saved');
      return 1;
    }
    if (e instanceof NetworkError) {
      say(`server ${config.server}: unreachable (${e.message}); nothing was saved`);
      return 1;
    }
    throw e;
  }
  saveClientToken(ctx.paths, token);
  ctx.out(`the client token of ${me.name} is saved in ${ctx.paths.clientTokenFile}; fornax lease can run`);
  return 0;
}
