import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { and, count, eq, gt, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { type FileKind, files, uploads } from '../db/schema.js';
import { blendFileVersion } from '../files/blend.js';
import { mimeOf } from '../files/mime.js';
import type { RouteDeps } from '../http/deps.js';
import { sign } from '../http/signing.js';
import { notFound, tooMany } from './errors.js';

export const UPLOAD_LINK_TTL_MS = 3_600_000;
/** Open (unused, unexpired) upload links one token may hold. */
export const MAX_OPEN_UPLOAD_LINKS = 100;
export type FileRow = typeof files.$inferSelect;

/** The last path segment, without control characters, at most 200 characters; "file" when nothing is left. */
export function cleanFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const clean = [...last.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, 200).join('');
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}

export async function saveFile(
  deps: RouteDeps,
  input: { owner: string; id?: string; name: string; kind: FileKind; jobId?: string | null; source: Readable; maxBytes: number },
): Promise<FileRow> {
  const id = input.id ?? ulid(deps.clock().getTime());
  // Inputs carry a client's file name; output names are already checked by cleanOutputName and may contain "/".
  const name = input.kind === 'input' ? cleanFileName(input.name) : input.name;
  const { size, sha256 } = await deps.store.write(id, input.source, input.maxBytes);
  // Spec 14 § 3.1: the Blender version of an uploaded .blend, for the warning at submit_job; an unreadable header is no error.
  const blender = input.kind === 'input' && extname(name).toLowerCase() === '.blend' ? await blendFileVersion(deps.store.pathOf(id)) : null;
  const row: FileRow = {
    id, ownerTokenId: input.owner, kind: input.kind, jobId: input.jobId ?? null, name, size, sha256, mime: mimeOf(name), meta: blender ? { blender } : null, createdAt: deps.clock(),
  };
  deps.db.insert(files).values(row).run();
  return row;
}

export function createUploadLink(deps: RouteDeps, owner: string, name: string): { fileId: string; url: string; expiresAt: Date } {
  const now = deps.clock();
  const [open] = deps.db
    .select({ n: count() })
    .from(uploads)
    .where(and(eq(uploads.ownerTokenId, owner), isNull(uploads.usedAt), gt(uploads.expiresAt, now)))
    .all();
  if ((open?.n ?? 0) >= MAX_OPEN_UPLOAD_LINKS) {
    throw tooMany(`at most ${MAX_OPEN_UPLOAD_LINKS} upload links may be open per token; use them or let them expire (after 1 hour)`);
  }
  const id = randomBytes(16).toString('base64url');
  const fileId = ulid(now.getTime());
  const expiresAt = new Date(now.getTime() + UPLOAD_LINK_TTL_MS);
  deps.db.insert(uploads).values({ id, ownerTokenId: owner, name: cleanFileName(name), fileId, expiresAt, createdAt: now }).run();
  return { fileId, expiresAt, url: `${deps.config.publicUrl}/api/uploads/${sign(deps.config.secret, 'upload', id, expiresAt)}` };
}

/**
 * What create_upload and POST /api/uploads answer: the link and a curl command to run with the local path. -T streams
 * the file with PUT (never loading it into memory); --fail-with-body exits non-zero on 4xx/5xx and still shows the
 * server's message (e.g. a 413 or an expired link).
 */
export function uploadLinkView(link: { fileId: string; url: string; expiresAt: Date }) {
  return {
    file_id: link.fileId,
    url: link.url,
    expires_at: link.expiresAt.toISOString(),
    curl: `curl --fail-with-body -sS -T "<path>" -H "Content-Type: application/octet-stream" "${link.url}"`,
  };
}

/** Take an upload link for one upload; null when unknown, used or expired. */
export function takeUploadLink(db: Db, id: string, now: Date) {
  return db.update(uploads).set({ usedAt: now }).where(and(eq(uploads.id, id), isNull(uploads.usedAt), gt(uploads.expiresAt, now))).returning().get() ?? null;
}

export function releaseUploadLink(db: Db, id: string): void {
  db.update(uploads).set({ usedAt: null }).where(eq(uploads.id, id)).run();
}

export function getOwnFile(db: Db, owner: string, id: string): FileRow {
  const row = db.select().from(files).where(and(eq(files.id, id), eq(files.ownerTokenId, owner))).get();
  if (!row) throw notFound(`file ${id} not found`);
  return row;
}

/**
 * Delete the rows, then their disk files. The database is the truth: a disk file that cannot be removed (EBUSY,
 * EPERM) stays behind for the disk sweep (maintenance) and is only counted; this never throws for a disk error.
 */
export async function deleteFiles(deps: RouteDeps, rows: FileRow[]): Promise<{ failed: number }> {
  let failed = 0;
  for (const r of rows) {
    deps.db.delete(files).where(eq(files.id, r.id)).run();
    try {
      await deps.store.remove(r.id);
    } catch {
      failed++;
    }
  }
  return { failed };
}

export const fileView = (r: FileRow) => ({
  id: r.id, name: r.name, size: r.size, sha256: r.sha256, mime: r.mime, created_at: r.createdAt.toISOString(),
});
