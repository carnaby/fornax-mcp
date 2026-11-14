import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseToken } from '@fornax/protocol';
import { Document, isMap, parse as parseYaml, parseDocument } from 'yaml';
import { z } from 'zod';
import type { Paths } from './paths.js';

/** A tool's name in worker.yaml and in {tool.<name>}. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** Local configuration is missing or wrong; the message says what to do. */
export class ConfigError extends Error {}

/** Why a server URL cannot be used (it would carry secrets or parts the API paths are appended after), or null. */
export function serverUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'the server must be an http(s) URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'the server must be an http(s) URL';
  if (u.username || u.password || /[?#]/.test(raw)) return 'the server URL must not contain a user name, password, query or fragment';
  return null;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** A warning for plain http to another computer (the token would cross the network readable), or null. */
export function serverWarning(server: string): string | null {
  const u = new URL(server);
  if (u.protocol !== 'http:' || LOOPBACK.test(u.hostname)) return null;
  return `warning: ${server} is plain http: the token and the job files cross the network not encrypted; use https unless this network is trusted`;
}

/** Spec 05a 2.1: the card's whole memory in use (all programs) above which the worker takes no job. No key: no check. */
const gpuYaml = z.strictObject({ max_used_mib: z.number().int().min(256).max(1_048_576).nullish() });

const workerYaml = z.strictObject({
  server: z.url({ protocol: /^https?$/, error: 'server must be an http(s) URL' }).superRefine((v, ctx) => {
    const problem = serverUrlProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  tools: z
    .record(z.string().regex(TOOL_NAME, 'tool names are a-z, 0-9 and "_", starting with a letter'), z.string().min(1))
    .nullish()
    .transform((v) => v ?? {}),
  gpu: gpuYaml.nullish(),
});

export type WorkerConfig = { server: string; tools: Record<string, string>; gpu: { maxUsedMib: number | null } };

export function readWorkerConfig(paths: Paths): WorkerConfig {
  if (!existsSync(paths.configFile)) {
    throw new ConfigError(`${paths.configFile} does not exist; pair this PC first: fornax worker pair --server <url> --name <name>`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(paths.configFile, 'utf8')) ?? {};
  } catch (e) {
    throw new ConfigError(`${paths.configFile} is not valid YAML: ${(e as Error).message}`);
  }
  const r = workerYaml.safeParse(raw);
  if (!r.success) throw new ConfigError(`invalid ${paths.configFile}: ${z.prettifyError(r.error)}`);
  return { server: r.data.server.replace(/\/+$/, ''), tools: r.data.tools, gpu: { maxUsedMib: r.data.gpu?.max_used_mib ?? null } };
}

/**
 * Before pairing: worker.yaml is absent or parseable, and the configuration directory can be written. Pairing uses up
 * the invite, so a local problem must show before it.
 */
export function checkWritableConfig(paths: Paths): void {
  if (existsSync(paths.configFile)) {
    let ok = false;
    try {
      // saveServer sets a key in it: it must be a mapping (or empty).
      const doc = parseDocument(readFileSync(paths.configFile, 'utf8'));
      ok = doc.errors.length === 0 && (doc.contents === null || isMap(doc.contents));
    } catch {
      // Unreadable: reported below.
    }
    if (!ok) throw new ConfigError(`${paths.configFile} is not valid YAML; fix or remove it, then pair again`);
  }
  const probe = join(paths.configDir, `.write-test-${process.pid}`);
  try {
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (e) {
    throw new ConfigError(`cannot write to ${paths.configDir} (${(e as NodeJS.ErrnoException).code ?? 'error'}); nothing was sent to the server`);
  }
}

/** Set the server URL in worker.yaml, keeping the tools and any comments already there. */
export function saveServer(paths: Paths, server: string): void {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  const doc = existsSync(paths.configFile) ? parseDocument(readFileSync(paths.configFile, 'utf8')) : new Document({ server, tools: {} });
  doc.set('server', server);
  writeFileSync(paths.configFile, doc.toString());
}

/** The worker token, or null before pairing. The file's content is never echoed. */
export function readToken(paths: Paths): string | null {
  if (!existsSync(paths.tokenFile)) return null;
  const token = readFileSync(paths.tokenFile, 'utf8').trim();
  if (!parseToken(token)) throw new ConfigError(`${paths.tokenFile} does not hold a Fornax token; pair again with fornax worker pair --force`);
  return token;
}

/** A token file: mode 0600 on Linux (Windows relies on the profile ACL). */
function writeTokenFile(paths: Paths, file: string, token: string): void {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  // The mode applies only when the file is created; an older file keeps its mode otherwise.
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

export function saveToken(paths: Paths, token: string): void {
  writeTokenFile(paths, paths.tokenFile, token);
}

export function saveClientToken(paths: Paths, token: string): void {
  writeTokenFile(paths, paths.clientTokenFile, token);
}

/** Spec 05a 4.3: the client token for fornax lease, FORNAX_CLIENT_TOKEN before the file; null when there is none. Never echoed. */
export function readClientToken(paths: Paths, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.FORNAX_CLIENT_TOKEN?.trim();
  if (fromEnv) {
    if (!parseToken(fromEnv)) throw new ConfigError('FORNAX_CLIENT_TOKEN does not hold a Fornax token');
    return fromEnv;
  }
  if (!existsSync(paths.clientTokenFile)) return null;
  const token = readFileSync(paths.clientTokenFile, 'utf8').trim();
  if (!parseToken(token)) throw new ConfigError(`${paths.clientTokenFile} does not hold a Fornax token; store a new one with fornax lease token`);
  return token;
}
