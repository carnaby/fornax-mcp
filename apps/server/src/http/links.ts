import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import { jobs } from '../db/schema.js';
import type { FileRow } from '../domain/files.js';
import type { JobRow } from '../domain/jobs.js';
import { downloadableFile } from '../domain/outputs.js';
import { ownerActive } from '../domain/tokens.js';
import type { RouteDeps } from './deps.js';
import { sign, verify } from './signing.js';

export const DOWNLOAD_LINK_TTL_MS = 86_400_000;

/**
 * A result link lasts as long as its job: a finished job's until the end of its retention (finished_at + retention);
 * an unfinished job's for the retention period from now, which always ends before the job's own retention does.
 */
export function resultLinkExpiry(config: Config, job: JobRow, now: Date): Date {
  return new Date((job.finishedAt ?? now).getTime() + config.retention.finishedMs);
}

export function resultPath(deps: RouteDeps, job: JobRow): string {
  return `/r/${sign(deps.config.secret, 'result', job.id, resultLinkExpiry(deps.config, job, deps.clock()))}`;
}

export const resultUrl = (deps: RouteDeps, job: JobRow): string => `${deps.config.publicUrl}${resultPath(deps, job)}`;

/** The job a result link opens; null when the link is invalid or expired, the job is gone, or its owner is no longer active. */
export function jobOfResultLink(deps: RouteDeps, signed: string): JobRow | null {
  const id = verify(deps.config.secret, 'result', signed, deps.clock());
  const job = id ? deps.db.select().from(jobs).where(eq(jobs.id, id)).get() : undefined;
  return job && ownerActive(deps.db, job.ownerTokenId) ? job : null;
}

const encodeName = (name: string): string => name.split('/').map(encodeURIComponent).join('/');

/** A relative path that downloads one file of a job without a token for 24 hours; the signature names the job and the file. */
export function downloadPath(deps: RouteDeps, job: JobRow, file: FileRow): { path: string; expiresAt: Date } {
  const expiresAt = new Date(deps.clock().getTime() + DOWNLOAD_LINK_TTL_MS);
  const sig = sign(deps.config.secret, 'download', `${job.id}:${file.id}`, expiresAt);
  return { path: `/api/jobs/${job.id}/outputs/${encodeName(file.name)}?sig=${sig}`, expiresAt };
}

export function downloadUrl(deps: RouteDeps, job: JobRow, file: FileRow): { url: string; expiresAt: Date } {
  const { path, expiresAt } = downloadPath(deps, job, file);
  return { url: `${deps.config.publicUrl}${path}`, expiresAt };
}

/** The file a `?sig=` download may serve: the signature must be valid for exactly this job and this file. */
export function fileOfDownloadLink(deps: RouteDeps, jobId: string, name: string, sig: string): FileRow | null {
  const payload = verify(deps.config.secret, 'download', sig, deps.clock());
  if (!payload) return null;
  const job = deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job || !ownerActive(deps.db, job.ownerTokenId)) return null;
  const file = downloadableFile(deps.db, job, name);
  return file && payload === `${job.id}:${file.id}` ? file : null;
}

/** Spec 14 § 4.1: a 24-hour link to a ZIP of all outputs and the log; null while the job has no outputs. */
export function archivePath(deps: RouteDeps, job: JobRow): string | null {
  if (!job.manifest || job.manifest.outputs.length === 0) return null;
  const expiresAt = new Date(deps.clock().getTime() + DOWNLOAD_LINK_TTL_MS);
  return `/api/jobs/${job.id}/archive.zip?sig=${sign(deps.config.secret, 'archive', job.id, expiresAt)}`;
}

export function archiveUrl(deps: RouteDeps, job: JobRow): string | null {
  const path = archivePath(deps, job);
  return path === null ? null : `${deps.config.publicUrl}${path}`;
}

/** The job an archive link opens: the signature must name exactly this job, and its owner must be active. */
export function jobOfArchiveLink(deps: RouteDeps, jobId: string, sig: string): JobRow | null {
  if (verify(deps.config.secret, 'archive', sig, deps.clock()) !== jobId) return null;
  const job = deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  return job && ownerActive(deps.db, job.ownerTokenId) ? job : null;
}
