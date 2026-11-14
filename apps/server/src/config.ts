import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MB = 1024 * 1024;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Every environment variable the server reads (spec 11), in the order of .env.example (a test compares them). */
export const CONFIG_VARIABLES = [
  'FORNAX_SECRET',
  'PUBLIC_URL',
  'DATA_DIR',
  'PORT',
  'HOST',
  'TRUST_PROXY',
  'LOG_LEVEL',
  'FORNAX_MAX_UPLOAD_MB',
  'FORNAX_MAX_OUTPUT_MB',
  'FORNAX_MAX_QUEUED_PER_TOKEN',
  'FORNAX_FINISHED_DAYS',
  'FORNAX_ORPHAN_UPLOAD_HOURS',
  'FORNAX_UNAVAILABLE_TYPE_DAYS',
  'FORNAX_PENDING_TOKEN_DAYS',
  'FORNAX_WEBHOOK_PREFIXES',
  'FORNAX_WORKER_ZIP',
] as const;

export type Config = {
  dataDir: string;
  dbFile: string;
  filesDir: string;
  publicUrl: string;
  /** False when PUBLIC_URL was not set: links then point to localhost. */
  publicUrlConfigured: boolean;
  /** Key for signed links (FORNAX_SECRET). */
  secret: string;
  port: number;
  host: string;
  /** Reverse proxies in front whose X-Forwarded-* headers are trusted; 0 trusts none. */
  trustProxy: number;
  limits: { maxUploadBytes: number; maxOutputBytes: number; maxQueuedPerToken: number };
  retention: { finishedMs: number; orphanUploadMs: number; unavailableTypeMs: number; pendingTokenMs: number };
  webhooks: { allowedPrefixes: string[] };
  /** The worker bundle served at /downloads/fornax-worker.zip. */
  workerZip: string;
};

type Env = Record<string, string | undefined>;

const here = dirname(fileURLToPath(import.meta.url));

/** <server package>/downloads/fornax-worker.zip, seen from src/ (tests) and from dist/src/ (the built server). */
export function defaultWorkerZip(): string {
  const candidates = [join(here, '..', 'downloads', 'fornax-worker.zip'), join(here, '..', '..', 'downloads', 'fornax-worker.zip')];
  return candidates.find((p) => existsSync(p)) ?? candidates[1]!;
}

/** The trimmed value; undefined when unset or blank. */
const valueOf = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = valueOf(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, not "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

function amount(env: Env, name: string, fallback: number): number {
  const raw = valueOf(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be a number of 0 or more, not "${raw}"`);
  return Number(raw);
}

/** Scheme and host only: pages and links use root-relative paths, so Fornax is always served at the root. */
function publicUrlOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const example = 'such as https://fornax.example.com';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_URL must be an http(s) URL, ${example}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`PUBLIC_URL must be an http(s) URL, ${example}`);
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
    throw new Error(`PUBLIC_URL must be only a scheme and a host (Fornax is served at the root), ${example}`);
  }
  return u.origin;
}

/** Comma-separated callback prefixes; each an http(s) URL whose normalized form ends with "/", so "/hooks" cannot match "/hooksevil". */
function webhookPrefixes(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => {
      let u: URL | null = null;
      try {
        u = new URL(p);
      } catch {
        // reported below
      }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new Error(`FORNAX_WEBHOOK_PREFIXES: ${p} must be an http(s) URL`);
      if (!u.href.endsWith('/')) throw new Error(`FORNAX_WEBHOOK_PREFIXES: ${p} must end with "/"`);
      return p;
    });
}

/** The server's configuration, from environment variables only (spec 11). Throws with the variable's name on a bad value. */
export function loadConfig(env: Env = process.env): Config {
  const secret = env.FORNAX_SECRET ?? '';
  if (secret.length < 32) throw new Error('FORNAX_SECRET must be set to at least 32 characters');
  const dataDir = valueOf(env, 'DATA_DIR') ?? '/data';
  const port = wholeNumber(env, 'PORT', 3000, 1, 65_535);
  const publicUrl = publicUrlOf(valueOf(env, 'PUBLIC_URL'));
  return {
    dataDir,
    dbFile: join(dataDir, 'fornax.db'),
    filesDir: join(dataDir, 'files'),
    publicUrl: publicUrl ?? `http://localhost:${port}`,
    publicUrlConfigured: publicUrl !== null,
    secret,
    port,
    host: valueOf(env, 'HOST') ?? '0.0.0.0',
    trustProxy: wholeNumber(env, 'TRUST_PROXY', 0, 0, 10),
    limits: {
      maxUploadBytes: wholeNumber(env, 'FORNAX_MAX_UPLOAD_MB', 4096, 1, 1_048_576) * MB,
      maxOutputBytes: wholeNumber(env, 'FORNAX_MAX_OUTPUT_MB', 4096, 1, 1_048_576) * MB,
      maxQueuedPerToken: wholeNumber(env, 'FORNAX_MAX_QUEUED_PER_TOKEN', 50, 1, 100_000),
    },
    retention: {
      finishedMs: amount(env, 'FORNAX_FINISHED_DAYS', 14) * DAY,
      orphanUploadMs: amount(env, 'FORNAX_ORPHAN_UPLOAD_HOURS', 24) * HOUR,
      unavailableTypeMs: amount(env, 'FORNAX_UNAVAILABLE_TYPE_DAYS', 7) * DAY,
      pendingTokenMs: amount(env, 'FORNAX_PENDING_TOKEN_DAYS', 7) * DAY,
    },
    webhooks: { allowedPrefixes: webhookPrefixes(valueOf(env, 'FORNAX_WEBHOOK_PREFIXES')) },
    workerZip: valueOf(env, 'FORNAX_WORKER_ZIP') ?? defaultWorkerZip(),
  };
}
