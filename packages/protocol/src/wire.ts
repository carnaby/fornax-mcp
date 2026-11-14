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

const mib = z.number().int().min(0).max(16_777_216);

/** Spec 05a 2.4: why the worker takes no job now. */
export const workerWaiting = z.union([
  z.strictObject({ reason: z.literal('gpu_busy'), used_mib: mib, total_mib: mib, limit_mib: mib }),
  z.strictObject({ reason: z.literal('gpu_unreadable'), error: z.string().max(200), limit_mib: mib }),
]);
export type WorkerWaiting = z.infer<typeof workerWaiting>;

/** PUT /api/worker/status: `waiting` is null when the worker takes jobs. */
export const statusBody = z.strictObject({ waiting: workerWaiting.nullable() });
