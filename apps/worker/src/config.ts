import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseToken } from '@fornax/protocol';
import { Document, parse as parseYaml, parseDocument } from 'yaml';
import { z } from 'zod';
import type { Paths } from './paths.js';

/** A tool's name in worker.yaml and in {tool.<name>}. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** Local configuration is missing or wrong; the message says what to do. */
export class ConfigError extends Error {}

const workerYaml = z.strictObject({
  server: z.url({ protocol: /^https?$/, error: 'server must be an http(s) URL' }),
  tools: z
    .record(z.string().regex(TOOL_NAME, 'tool names are a-z, 0-9 and "_", starting with a letter'), z.string().min(1))
    .nullish()
    .transform((v) => v ?? {}),
});

export type WorkerConfig = { server: string; tools: Record<string, string> };

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
  return { server: r.data.server.replace(/\/+$/, ''), tools: r.data.tools };
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

export function saveToken(paths: Paths, token: string): void {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  // The mode applies only when the file is created; an older file keeps its mode otherwise. Windows relies on the profile ACL.
  if (process.platform !== 'win32') chmodSync(paths.tokenFile, 0o600);
}
