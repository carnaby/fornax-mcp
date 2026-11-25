import type { JobTypeContract, TokenRole, WorkerWaiting } from '@fornax/protocol';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').$type<TokenRole>().notNull(),
  hash: text('hash').notNull().unique(),
  fingerprint: text('fingerprint').notNull(),
  /** Hex HMAC key for webhooks (clients only). */
  webhookKey: text('webhook_key'),
  status: text('status', { enum: ['pending', 'active', 'revoked'] }).notNull(),
  inviteId: text('invite_id'),
  createdAt: ts('created_at').notNull(),
  approvedAt: ts('approved_at'),
  lastSeenAt: ts('last_seen_at'),
});

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').$type<TokenRole>().notNull(),
  expiresAt: ts('expires_at').notNull(),
  tokenId: text('token_id'),
  createdAt: ts('created_at').notNull(),
});

export const jobTypes = sqliteTable('job_types', {
  name: text('name').primaryKey(),
  contract: text('contract', { mode: 'json' }).$type<JobTypeContract>().notNull(),
  contractHash: text('contract_hash').notNull(),
  offered: integer('offered', { mode: 'boolean' }).notNull(),
  lastOfferedAt: ts('last_offered_at').notNull(),
  /** Spec 12 § 3.2: the last `fornax-environment:` line of the type's check, as the worker announced it; null without one. */
  environment: text('environment'),
});

export type FileKind = 'input' | 'output' | 'log' | 'preview';
export type Meta = Record<string, string | number | boolean | null>;

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    ownerTokenId: text('owner_token_id').notNull(),
    kind: text('kind').$type<FileKind>().notNull(),
    /** The job a produced file (output, preview, log) belongs to; null for inputs (job_inputs holds those, spec 14). */
    jobId: text('job_id'),
    name: text('name').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    meta: text('meta', { mode: 'json' }).$type<Meta>(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('files_job').on(t.jobId), index('files_owner').on(t.ownerTokenId)],
);

/** Spec 14 § 2.1: which jobs hold which input files; one input file may serve several jobs of its owner. */
export const jobInputs = sqliteTable(
  'job_inputs',
  { jobId: text('job_id').notNull(), fileId: text('file_id').notNull() },
  (t) => [primaryKey({ columns: [t.jobId, t.fileId] }), index('job_inputs_file').on(t.fileId)],
);

/** One-time upload links. The file id is assigned when the link is made, so the client knows it before uploading. */
export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  ownerTokenId: text('owner_token_id').notNull(),
  name: text('name').notNull(),
  fileId: text('file_id').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull(),
});

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type ManifestOutput = { name: string; file_id: string; mime: string; size: number; sha256: string; meta: Meta | null; preview: string | null };
export type Manifest = { outputs: ManifestOutput[]; log: string | null };

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    ownerTokenId: text('owner_token_id').notNull(),
    type: text('type').notNull(),
    params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Input name → file id. */
    inputs: text('inputs', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    /** Spec 07 § 2.1: 0 idle (never starts by itself), 1 normal, 2 high. */
    priority: integer('priority').notNull(),
    group: text('group'),
    callbackUrl: text('callback_url'),
    state: text('state').$type<JobState>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** Releases for a broken environment (exit code 3); the second one counts as a failed attempt. */
    envReleases: integer('env_releases').notNull().default(0),
    runAfter: ts('run_after').notNull(),
    leaseId: text('lease_id'),
    leaseExpiresAt: ts('lease_expires_at'),
    /** The worker's first sign of holding the job (heartbeat or input download); null until then. */
    confirmedAt: ts('confirmed_at'),
    progress: real('progress'),
    progressMessage: text('progress_message'),
    error: text('error'),
    manifest: text('manifest', { mode: 'json' }).$type<Manifest>(),
    createdAt: ts('created_at').notNull(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    updatedAt: ts('updated_at').notNull(),
    /** Spec 06 2.1: the place in the queue (lower runs first). Read only while the job is queued; every move into `queued` sets it. */
    queueRank: integer('queue_rank'),
    /** Spec 07 § 3.1: the lease of the run that Requeue or Pause stopped; its heartbeat is told to stop. Cleared by the next claim. */
    stoppedLeaseId: text('stopped_lease_id'),
    /** Spec 07 § 2.3: since when the job is idle; null when it is not. */
    idleSince: ts('idle_since'),
    /** Spec 09 § 2: who submitted the job, as the agent named itself; every client sees it. Null without one. */
    agent: text('agent'),
  },
  (t) => [index('jobs_queue').on(t.state, t.queueRank), index('jobs_owner').on(t.ownerTokenId), index('jobs_group').on(t.group)],
);

/** The one worker: one row with id 1. */
export const workerState = sqliteTable('worker', {
  id: integer('id').primaryKey(),
  tokenId: text('token_id').notNull(),
  hostname: text('hostname').notNull(),
  version: text('version'),
  lastSeenAt: ts('last_seen_at').notNull(),
  /** Spec 05a 2.4: why the worker takes no job now (its last status), or null. */
  waiting: text('waiting', { mode: 'json' }).$type<WorkerWaiting>(),
});

/** Spec 06 2.2: the operator's pause, one row with id 1; no row means "not paused". */
export const queueControl = sqliteTable('queue_control', {
  id: integer('id').primaryKey(),
  paused: integer('paused', { mode: 'boolean' }).notNull(),
  pausedAt: ts('paused_at'),
});

export type DeliveryStatus = 'pending' | 'sent' | 'failed';

/** One webhook per finished job with a callback_url; the delivery loop sends it, at most three times. */
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    ownerTokenId: text('owner_token_id').notNull(),
    url: text('url').notNull(),
    /** The exact request body: {"job_id","state"}. */
    payload: text('payload').notNull(),
    /** Attempts made so far. */
    attempt: integer('attempt').notNull().default(0),
    nextAt: ts('next_at').notNull(),
    status: text('status').$type<DeliveryStatus>().notNull(),
    /** Short: "HTTP 500", "timeout", "connection failed" or why it was not sent; never the response body. */
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('webhook_due').on(t.status, t.nextAt), index('webhook_job').on(t.jobId)],
);
