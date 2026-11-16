import { z } from 'zod';
import { jobTypeContract } from './contract.js';

export const WORKER_HEADERS = { name: 'x-fornax-worker', version: 'x-fornax-version', lease: 'x-fornax-lease', warning: 'x-fornax-warning' } as const;

/** The longest a claim waits for a job before answering 204, in seconds. */
export const MAX_CLAIM_WAIT_S = 30;

/** A worker holds a job this long without a heartbeat (server) and fits its retries into it (worker). */
export const LEASE_MS = 600_000;

/** Why a worker gives a job back: it stops (never counts), or the type's environment is broken (spec 5, exit code 3). */
export const RELEASE_REASONS = ['stopping', 'environment'] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export const announceBody = z.strictObject({ types: z.array(jobTypeContract).max(100) });

export const claimBody = z.strictObject({ wait: z.number().int().min(0).max(MAX_CLAIM_WAIT_S).default(25) });

export const claimedJob = z.object({
  id: z.string(),
  lease: z.string(),
  lease_until: z.string(),
  attempt: z.number().int(),
  type: z.string(),
  contract_hash: z.string(),
  params: z.record(z.string(), z.unknown()),
  inputs: z.array(z.object({ name: z.string(), file_name: z.string(), size: z.number().int(), sha256: z.string() })),
});
export type ClaimedJob = z.infer<typeof claimedJob>;

export const heartbeatBody = z.strictObject({
  lease: z.string().min(1),
  progress: z.number().min(0).max(1).nullable().default(null),
  message: z.string().max(200).nullable().default(null),
});
export const heartbeatReply = z.object({ lease_until: z.string().nullable(), cancel: z.boolean() });

export const failBody = z.strictObject({ lease: z.string().min(1), error: z.string().max(10_000), permanent: z.boolean().default(false) });
export const releaseBody = z.strictObject({ lease: z.string().min(1), reason: z.enum(RELEASE_REASONS).default('stopping') });

const metaValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

/** One output's entry in `{out}/outputs.json` and in the complete call; `preview` names another output. */
export const outputInfo = z.strictObject({ meta: z.record(z.string(), metaValue).optional(), preview: z.string().optional() });
/** `{out}/outputs.json` (spec 6.4): output name → metadata and preview. */
export const outputsJson = z.record(z.string(), outputInfo);
export type OutputsJson = z.infer<typeof outputsJson>;

export const completeBody = z.strictObject({
  lease: z.string().min(1),
  /** Metadata per uploaded output name; `preview` names another uploaded output that becomes its preview. */
  outputs: outputsJson.default({}),
});
export type CompleteBody = z.infer<typeof completeBody>;

/** The largest MiB figure the worker status takes (16 TiB): a reading above it is not a real card. */
export const MAX_MIB = 16_777_216;
const mib = z.number().int().min(0).max(MAX_MIB);

/** Spec 05a 2.4: why the worker takes no job now. */
export const workerWaiting = z.union([
  z.strictObject({ reason: z.literal('gpu_busy'), used_mib: mib, total_mib: mib, limit_mib: mib }),
  z.strictObject({ reason: z.literal('gpu_unreadable'), error: z.string().max(200), limit_mib: mib }),
]);
export type WorkerWaiting = z.infer<typeof workerWaiting>;

/** PUT /api/worker/status: `waiting` is null when the worker takes jobs. */
export const statusBody = z.strictObject({ waiting: workerWaiting.nullable() });

/** GET /downloads/fornax-worker.json (spec 05c 6): what `fornax update` checks before it downloads the zip. */
export type WorkerBundleInfo = { version: string; sha256: string; size: number };
/** Spec 06d 2.1: one tray installer the server carries. */
export type TrayInstallerInfo = { sha256: string; size: number };
/** Spec 06d 2.1: GET /downloads/fornax-tray.json; an installer the server does not have is null. */
export type TrayBundleInfo = { version: string; msi: TrayInstallerInfo | null; deb: TrayInstallerInfo | null };

/** Spec 06 2.3: where the operator moves a waiting job (exactly one of these). */
export const moveBody = z.union([
  z.strictObject({ to: z.enum(['top', 'bottom']) }),
  z.strictObject({ before: z.string().min(1).max(40) }),
  z.strictObject({ after: z.string().min(1).max(40) }),
]);
export type MoveTarget = z.infer<typeof moveBody>;

/** Spec 06 2.3: PUT /api/worker/pause. */
export const pauseBody = z.strictObject({ paused: z.boolean() });

/** Spec 06 2.3: one job as the operator sees it (any owner). */
export type OperatorJob = {
  id: string;
  type: string;
  /** The owner's token name. */
  owner: string | null;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  /** params.label when it is a string (fornax lease --label), else null. */
  label: string | null;
  group: string | null;
  priority: 'low' | 'normal' | 'high';
  /** Input name → the uploaded file's name (null when the file is gone). */
  inputs: Record<string, string | null>;
  attempts: number;
  type_unavailable: boolean;
  /** A waiting job's next attempt time while it is still ahead, else null. */
  run_after: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: number | null;
  progress_message: string | null;
  error: string | null;
  /** The signed result page. */
  result_url: string;
};

/** Spec 06 2.3: GET /api/worker/jobs. */
export type OperatorQueue = {
  server_time: string;
  /** Spec 06d 2.3: the server's version; the tray offers an update when it is newer than the tray or the CLI. */
  server_version: string;
  /** 16 hex digits; changes exactly when something the operator sees changes (not time, last_seen or result links). */
  change: string;
  paused: boolean;
  worker: { online: boolean; last_seen: string | null; version: string | null; waiting: { reason: string; message: string } | null };
  running: OperatorJob | null;
  queued: OperatorJob[];
  finished: OperatorJob[];
};
