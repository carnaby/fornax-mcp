import type { Readable } from 'node:stream';
import { cleanOutputName, type CompleteBody } from '@fornax/protocol';
import { and, eq, inArray, ne, notLike, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, type Manifest } from '../db/schema.js';
import { serverPreviewName } from '../files/preview.js';
import type { RouteDeps } from '../http/deps.js';
import { badRequest, tooLarge } from './errors.js';
import { deleteFiles, type FileRow, saveFile } from './files.js';
import { finishJob } from './finish.js';
import type { JobRow } from './jobs.js';
import { ownedJob } from './queue.js';

const PRODUCED = ['output', 'preview', 'log'] as const;

export function jobFile(db: Db, jobId: string, name: string): FileRow | null {
  return db.select().from(files).where(and(eq(files.jobId, jobId), eq(files.name, name), inArray(files.kind, [...PRODUCED]))).get() ?? null;
}

/** What a client may download: an output listed in the manifest, its preview, or the log; nothing before the job has finished. */
export function downloadableFile(db: Db, job: JobRow, name: string): FileRow | null {
  const m = job.manifest;
  if (!m) return null;
  const allowed = new Set<string>(m.log ? [m.log] : []);
  for (const o of m.outputs) {
    allowed.add(o.name);
    if (o.preview) allowed.add(o.preview);
  }
  return allowed.has(name) ? jobFile(db, job.id, name) : null;
}

/**
 * Bytes this upload may still use: the job limit minus the other produced files (a same-named file is replaced).
 * Server previews (names under .fornax/) do not count.
 */
export function outputBudget(deps: RouteDeps, jobId: string, lease: string, rawName: string): number {
  const job = ownedJob(deps.db, jobId, lease, ['running']);
  const name = cleanOutputName(rawName);
  if (!name) throw badRequest('invalid output name: a relative path of letters, digits, ".", "_" and "-", without leading dots');
  const [used] = deps.db
    .select({ n: sum(files.size) })
    .from(files)
    .where(and(eq(files.jobId, job.id), inArray(files.kind, [...PRODUCED]), ne(files.name, name), notLike(files.name, '.fornax/%')))
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

/** Whether the job holds any produced file (output, preview or log). */
export function hasProducedFiles(db: Db, jobId: string): boolean {
  return db.select({ id: files.id }).from(files).where(and(eq(files.jobId, jobId), inArray(files.kind, [...PRODUCED] as FileRow['kind'][]))).limit(1).get() !== undefined;
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
      const p = info.preview;
      if (p === undefined) continue;
      const target = byName.get(p);
      if (!target) throw badRequest(`preview ${p} was not uploaded`);
      // A preview is a file of its own: not the log, not the output itself, not another output this call lists.
      if (target.kind === 'log' || Object.hasOwn(body.outputs, p)) {
        throw badRequest(`preview ${p} of ${name} must be a separate image file, not the log or a listed output`);
      }
      previews.add(p);
    }
    for (const p of previews) db.update(files).set({ kind: 'preview' }).where(eq(files.id, byName.get(p)!.id)).run();
    const outputs = rows
      .filter((r) => r.kind === 'output' && !previews.has(r.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((r) => {
        const info = Object.hasOwn(body.outputs, r.name) ? body.outputs[r.name] : undefined;
        if (info?.meta) db.update(files).set({ meta: info.meta }).where(eq(files.id, r.id)).run();
        // The tool's own preview wins; otherwise the server's, when it made one.
        const own = serverPreviewName(r.name);
        const preview = info?.preview ?? (byName.get(own)?.kind === 'preview' ? own : null);
        return { name: r.name, file_id: r.id, mime: r.mime, size: r.size, sha256: r.sha256, meta: info?.meta ?? null, preview };
      });
    const manifest: Manifest = { outputs, log: rows.find((r) => r.kind === 'log')?.name ?? null };
    finishJob(db, job, { state: 'succeeded', manifest }, now);
    return manifest;
  });
}
