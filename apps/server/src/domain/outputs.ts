import type { Readable } from 'node:stream';
import { cleanOutputName, type CompleteBody } from '@fornax/protocol';
import { and, eq, inArray, ne, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, jobs, type Manifest } from '../db/schema.js';
import type { RouteDeps } from '../http/deps.js';
import { badRequest, tooLarge } from './errors.js';
import { deleteFiles, type FileRow, saveFile } from './files.js';
import { ownedJob } from './queue.js';

const PRODUCED = ['output', 'preview', 'log'] as const;

export function jobFile(db: Db, jobId: string, name: string): FileRow | null {
  return db.select().from(files).where(and(eq(files.jobId, jobId), eq(files.name, name), inArray(files.kind, [...PRODUCED]))).get() ?? null;
}

/** Bytes this upload may still use: the job limit minus the other produced files (a same-named file is replaced). */
export function outputBudget(deps: RouteDeps, jobId: string, lease: string, rawName: string): number {
  const job = ownedJob(deps.db, jobId, lease, ['running']);
  const name = cleanOutputName(rawName);
  if (!name) throw badRequest('invalid output name: a relative path of letters, digits, ".", "_" and "-", without leading dots');
  const [used] = deps.db
    .select({ n: sum(files.size) })
    .from(files)
    .where(and(eq(files.jobId, job.id), inArray(files.kind, [...PRODUCED]), ne(files.name, name)))
    .all();
  const left = deps.config.limits.maxOutputBytes - Number(used?.n ?? 0);
  if (left <= 0) throw tooLarge('the outputs of this job exceed the limit');
  return left;
}

/** Store one output of a running job; an earlier upload with the same name is replaced. */
export async function storeOutput(
  deps: RouteDeps, input: { jobId: string; lease: string; name: string; kind: 'output' | 'log'; source: Readable },
): Promise<FileRow> {
  const left = outputBudget(deps, input.jobId, input.lease, input.name);
  const job = ownedJob(deps.db, input.jobId, input.lease, ['running']);
  const name = cleanOutputName(input.name)!;
  const previous = jobFile(deps.db, job.id, name);
  const row = await saveFile(deps, { owner: job.ownerTokenId, name, kind: input.kind, jobId: job.id, source: input.source, maxBytes: left });
  try {
    // The job may have been canceled while the upload ran.
    ownedJob(deps.db, input.jobId, input.lease, ['running']);
  } catch (e) {
    await deleteFiles(deps, [row]);
    throw e;
  }
  if (previous) await deleteFiles(deps, [previous]);
  return row;
}

/** Remove what an attempt produced (a retry starts clean); the log stays when asked. */
export async function discardOutputs(deps: RouteDeps, jobId: string, opts: { keepLog: boolean }): Promise<void> {
  const kinds = opts.keepLog ? ['output', 'preview'] : [...PRODUCED];
  const rows = deps.db.select().from(files).where(and(eq(files.jobId, jobId), inArray(files.kind, kinds as FileRow['kind'][]))).all();
  await deleteFiles(deps, rows);
}

export function completeJob(db: Db, id: string, lease: string, body: CompleteBody, now: Date): Manifest {
  return db.transaction(() => {
    const job = ownedJob(db, id, lease, ['running']);
    const rows = db.select().from(files).where(and(eq(files.jobId, job.id), inArray(files.kind, ['output', 'preview', 'log']))).all();
    const byName = new Map(rows.map((r) => [r.name, r]));
    const previews = new Set<string>();
    for (const [name, info] of Object.entries(body.outputs)) {
      if (!byName.has(name)) throw badRequest(`output ${name} was not uploaded`);
      if (info.preview !== undefined) {
        if (!byName.has(info.preview)) throw badRequest(`preview ${info.preview} was not uploaded`);
        previews.add(info.preview);
      }
    }
    for (const p of previews) db.update(files).set({ kind: 'preview' }).where(eq(files.id, byName.get(p)!.id)).run();
    const outputs = rows
      .filter((r) => r.kind === 'output' && !previews.has(r.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((r) => {
        const info = Object.hasOwn(body.outputs, r.name) ? body.outputs[r.name] : undefined;
        if (info?.meta) db.update(files).set({ meta: info.meta }).where(eq(files.id, r.id)).run();
        return { name: r.name, file_id: r.id, mime: r.mime, size: r.size, sha256: r.sha256, meta: info?.meta ?? null, preview: info?.preview ?? null };
      });
    const manifest: Manifest = { outputs, log: rows.find((r) => r.kind === 'log')?.name ?? null };
    db.update(jobs)
      .set({ state: 'succeeded', progress: 1, manifest, error: null, leaseId: null, leaseExpiresAt: null, finishedAt: now, updatedAt: now })
      .where(eq(jobs.id, id))
      .run();
    return manifest;
  });
}
