import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import type { ManifestOutput } from '../../db/schema.js';
import { type JobRow, jobView } from '../../domain/jobs.js';
import { downloadableFile } from '../../domain/outputs.js';
import { INLINE_IMAGE_BYTES, INLINE_IMAGE_MIMES, INLINE_TEXT_BYTES, isTextMime } from '../../files/mime.js';
import type { RouteDeps } from '../deps.js';
import { downloadPath, jobOfResultLink } from '../links.js';
import { type Html, html, page, pageHeaders } from './html.js';

export const RESULT_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
export const LOG_TAIL_BYTES = 100_000;
const REFRESH_S = 5;

/** GET /r/<job_id>.<exp>.<sig>: a read-only page of one job, no JavaScript. The signature is the permission. */
export const resultPageRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.get<{ Params: { signed: string } }>('/r/:signed', async (req, reply) => {
    pageHeaders(reply, RESULT_CSP, 'private, no-store');
    const job = jobOfResultLink(deps, req.params.signed);
    if (!job) return reply.code(404).send(page({ title: 'Fornax', body: html`<h1>Not found</h1><p>This link is not valid or has expired.</p>` }));
    return reply.send(await resultPage(deps, job));
  });
};

const size = (bytes: number): string =>
  bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} kB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

function pretty(mime: string, text: string): string {
  if (mime !== 'application/json') return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** A file that is gone from disk (a retention race) reads as null. */
async function readText(deps: RouteDeps, id: string): Promise<string | null> {
  try {
    return (await readFile(deps.store.pathOf(id))).toString('utf8');
  } catch {
    return null;
  }
}

async function outputSection(deps: RouteDeps, job: JobRow, o: ManifestOutput): Promise<Html | null> {
  const file = downloadableFile(deps.db, job, o.name);
  if (!file) return null;
  const href = downloadPath(deps, job, file).path;
  const meta = o.meta ? Object.entries(o.meta).map(([k, v]) => ` · ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('') : '';
  const head = html`<h3>${o.name}</h3><p class="muted">${o.mime} · ${size(o.size)}${meta} · <a href="${href}">download</a></p>`;
  const preview = o.preview ? downloadableFile(deps.db, job, o.preview) : null;
  let body: Html | null = null;
  if (preview && INLINE_IMAGE_MIMES.has(preview.mime)) {
    body = html`<a href="${href}"><img src="${downloadPath(deps, job, preview).path}" alt="${o.name}" loading="lazy"></a>`;
  } else if (INLINE_IMAGE_MIMES.has(o.mime) && o.size <= INLINE_IMAGE_BYTES) {
    body = html`<img src="${href}" alt="${o.name}" loading="lazy">`;
  } else if (o.mime.startsWith('audio/')) {
    body = html`<audio controls preload="none" src="${href}"></audio>`;
  } else if (o.mime.startsWith('video/')) {
    body = html`<video controls preload="metadata" src="${href}"></video>`;
  } else if (isTextMime(o.mime) && o.size <= INLINE_TEXT_BYTES) {
    const text = await readText(deps, file.id);
    if (text === null) return null;
    body = html`<pre>${pretty(o.mime, text)}</pre>`;
  }
  return html`<section>${head}${body}</section>`;
}

async function resultPage(deps: RouteDeps, job: JobRow): Promise<string> {
  const view = jobView(deps.db, job);
  const active = job.state === 'queued' || job.state === 'running';
  const outputs = await Promise.all((job.manifest?.outputs ?? []).map((o) => outputSection(deps, job, o)));
  const logFile = job.manifest?.log ? downloadableFile(deps.db, job, job.manifest.log) : null;
  const log = logFile ? await deps.store.tail(logFile.id, LOG_TAIL_BYTES).catch(() => null) : null;
  const percent = job.progress === null ? null : Math.round(job.progress * 100);
  return page({
    title: `Fornax · ${job.type} · ${job.state}`,
    head: active ? html`<meta http-equiv="refresh" content="${REFRESH_S}">` : undefined,
    body: html`<h1>${job.type} <span class="muted">· ${job.state}</span></h1>
<p class="muted">Job ${job.id} · created ${view.created_at}${view.finished_at ? ` · finished ${view.finished_at}` : ''}</p>
${view.type_unavailable ? html`<p class="error">The worker does not offer this job type now; the job waits until it does.</p>` : null}
${view.position !== null ? html`<p>Place in the queue: ${view.position}</p>` : null}
${job.state === 'running' ? html`<p><progress max="100" value="${percent ?? 0}"></progress></p><p>${percent === null ? '' : `${percent} % `}${job.progressMessage ?? ''}</p>` : null}
${job.error ? html`<p class="error">${job.error}</p>` : null}
${active ? html`<p class="muted">This page refreshes every ${REFRESH_S} seconds.</p>` : null}
${outputs.some((o) => o !== null) ? html`<h2>Outputs</h2>${outputs}` : null}
${log && logFile ? html`<h2>Log</h2><p class="muted">${log.truncated ? 'The last 100 kB · ' : ''}<a href="${downloadPath(deps, job, logFile).path}">download</a></p><pre>${log.text}</pre>` : null}`,
  });
}
