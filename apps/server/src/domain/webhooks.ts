import { createHmac } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { type DeliveryStatus, tokens, webhookDeliveries } from '../db/schema.js';
import type { JobRow } from './jobs.js';

export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Pauses after a failed attempt: the second attempt 1 minute after the first, the third 5 minutes after the second. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000] as const;
export const WEBHOOK_TICK_MS = 3_000;
const BATCH = 20;

export type DeliveryRow = typeof webhookDeliveries.$inferSelect;
export type WebhookLog = { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
type Deps = { db: Db; config: Config; clock: () => Date };

/** The URL is allowed when its normalized form starts with one of the configured prefixes. */
export function callbackAllowed(url: string, prefixes: string[]): boolean {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return false;
  }
  return prefixes.some((p) => href.startsWith(new URL(p).href));
}

/** Called by finishJob: the job reached a final state; with a callback_url its webhook is queued, due at once. */
export function enqueueWebhook(db: Db, job: JobRow, now: Date): void {
  if (!job.callbackUrl) return;
  db.insert(webhookDeliveries)
    .values({
      id: ulid(now.getTime()), jobId: job.id, ownerTokenId: job.ownerTokenId, url: job.callbackUrl,
      payload: JSON.stringify({ job_id: job.id, state: job.state }), attempt: 0, nextAt: now, status: 'pending',
      lastError: null, createdAt: now, updatedAt: now,
    })
    .run();
}

/** The X-Fornax-Signature header: `sha256=<hex HMAC-SHA256(key, timestamp + "." + body)>`. */
export function signWebhook(key: Buffer, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Send every due delivery (at most 20, in parallel). */
export async function deliverWebhooks(deps: Deps, log: WebhookLog, opts: { timeoutMs?: number } = {}) {
  const now = deps.clock();
  const due = deps.db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAt, now)))
    .orderBy(asc(webhookDeliveries.nextAt))
    .limit(BATCH)
    .all();
  const outcomes = await Promise.all(due.map((d) => deliverOne(deps, d, now, log, opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS)));
  const count = (s: DeliveryStatus) => outcomes.filter((o) => o === s).length;
  return { sent: count('sent'), retrying: count('pending'), failed: count('failed') };
}

async function deliverOne(deps: Deps, d: DeliveryRow, now: Date, log: WebhookLog, timeoutMs: number): Promise<DeliveryStatus> {
  const record = (status: DeliveryStatus, values: { attempt?: number; lastError: string | null; nextAt?: Date }, http: number | null) => {
    deps.db.update(webhookDeliveries).set({ status, ...values, updatedAt: now }).where(eq(webhookDeliveries.id, d.id)).run();
    // Ids and the status code only: the URL (its path and query may hold the client's secrets) and the body stay out.
    log.info({ delivery: d.id, job: d.jobId, attempt: values.attempt ?? d.attempt, http, status }, 'webhook');
    return status;
  };
  const owner = deps.db.select().from(tokens).where(eq(tokens.id, d.ownerTokenId)).get();
  if (!owner || owner.status !== 'active' || !owner.webhookKey) return record('failed', { lastError: 'the owner token is not active' }, null);
  // Checked again when sending: a prefix removed from the config stops deliveries that were already queued.
  if (!callbackAllowed(d.url, deps.config.webhooks.allowedPrefixes)) return record('failed', { lastError: 'callback_url is no longer allowed' }, null);

  const attempt = d.attempt + 1;
  const timestamp = Math.floor(now.getTime() / 1000);
  let http: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(d.url, {
      method: 'POST',
      // A redirect is an answer, not a new target: it counts as a failure and is never followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'fornax-webhook',
        'x-fornax-timestamp': String(timestamp),
        'x-fornax-signature': signWebhook(Buffer.from(owner.webhookKey, 'hex'), timestamp, d.payload),
      },
      body: d.payload,
    });
    http = res.status;
    await res.body?.cancel().catch(() => undefined);
    if (res.status < 200 || res.status > 299) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).name === 'TimeoutError' ? 'timeout' : 'connection failed';
  }
  if (error === null) return record('sent', { attempt, lastError: null }, http);
  const delay = WEBHOOK_RETRY_DELAYS_MS[attempt - 1];
  return delay === undefined
    ? record('failed', { attempt, lastError: error }, http)
    : record('pending', { attempt, lastError: error, nextAt: new Date(now.getTime() + delay) }, http);
}

/** Sends due deliveries every `intervalMs`, one run at a time; stop() waits for a run in progress. */
export function startWebhookLoop(deps: Deps, log: WebhookLog, intervalMs = WEBHOOK_TICK_MS): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = deliverWebhooks(deps, log)
      .then(() => undefined)
      .catch((e: unknown) => log.error({ err: { message: (e as Error).message, stack: (e as Error).stack } }, 'webhook delivery failed'))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
