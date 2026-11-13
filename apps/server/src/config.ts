import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const MB = 1024 * 1024;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A callback prefix: an http(s) URL whose normalized form ends with "/", so "/hooks" cannot match "/hooksevil". */
const prefixUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .refine((u) => new URL(u).href.endsWith('/'), { error: 'must end with "/"' });

const fileSchema = z.strictObject({
  public_url: z.url().optional(),
  limits: z
    .strictObject({
      max_upload_mb: z.number().int().min(1).default(4096),
      max_output_mb: z.number().int().min(1).default(4096),
      max_queued_per_token: z.number().int().min(1).default(50),
    })
    .prefault({}),
  retention: z
    .strictObject({
      finished_days: z.number().min(0).default(14),
      orphan_upload_hours: z.number().min(0).default(24),
      unavailable_type_days: z.number().min(0).default(7),
      pending_token_days: z.number().min(0).default(7),
    })
    .prefault({}),
  webhooks: z.strictObject({ allowed_prefixes: z.array(prefixUrl).default([]) }).prefault({}),
});

export type Config = {
  dataDir: string;
  dbFile: string;
  filesDir: string;
  publicUrl: string;
  /** False when `public_url` was not set: links then point to localhost. */
  publicUrlConfigured: boolean;
  /** Key for signed links (FORNAX_SECRET). */
  secret: string;
  port: number;
  host: string;
  limits: { maxUploadBytes: number; maxOutputBytes: number; maxQueuedPerToken: number };
  retention: { finishedMs: number; orphanUploadMs: number; unavailableTypeMs: number; pendingTokenMs: number };
  webhooks: { allowedPrefixes: string[] };
};

/** Config from FORNAX_* variables and the optional YAML file (FORNAX_CONFIG, default <data>/fornax.yaml). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.FORNAX_DATA ?? '/data';
  const secret = env.FORNAX_SECRET ?? '';
  if (secret.length < 32) throw new Error('FORNAX_SECRET must be set to at least 32 characters');
  const explicit = env.FORNAX_CONFIG;
  const path = explicit ?? join(dataDir, 'fornax.yaml');
  if (explicit && !existsSync(path)) throw new Error(`config file ${path} does not exist`);
  const raw: unknown = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) ?? {}) : {};
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid ${path}: ${z.prettifyError(parsed.error)}`);
  const f = parsed.data;
  const port = Number(env.PORT ?? 3000);
  return {
    dataDir,
    dbFile: join(dataDir, 'fornax.db'),
    filesDir: join(dataDir, 'files'),
    publicUrlConfigured: f.public_url !== undefined,
    publicUrl: (f.public_url ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    secret,
    port,
    host: env.HOST ?? '0.0.0.0',
    limits: {
      maxUploadBytes: f.limits.max_upload_mb * MB,
      maxOutputBytes: f.limits.max_output_mb * MB,
      maxQueuedPerToken: f.limits.max_queued_per_token,
    },
    retention: {
      finishedMs: f.retention.finished_days * DAY,
      orphanUploadMs: f.retention.orphan_upload_hours * HOUR,
      unavailableTypeMs: f.retention.unavailable_type_days * DAY,
      pendingTokenMs: f.retention.pending_token_days * DAY,
    },
    webhooks: { allowedPrefixes: f.webhooks.allowed_prefixes },
  };
}
