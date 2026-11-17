import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tokens } from '../db/schema.js';
import { timeText } from './time-text.js';

/** params.label when it is a string (fornax lease --label), else null. */
export const labelOf = (params: Record<string, unknown>): string | null => (typeof params.label === 'string' ? params.label : null);

/** A token's name; null when its row is gone. */
export function ownerName(db: Db, tokenId: string): string | null {
  return db.select({ name: tokens.name }).from(tokens).where(eq(tokens.id, tokenId)).get()?.name ?? null;
}

/** Spec 09 § 2.4: who submitted a job, in a sentence: "by <agent>", else "by token <name>", else nothing. */
export function byText(agent: string | null, owner: string | null): string {
  if (agent) return `by ${agent}`;
  return owner ? `by token ${owner}` : '';
}

/** Spec 09 § 3.1: 'running lease "<label>" by <who> since <time>'. */
export function runningText(
  db: Db,
  r: { type: string; params: Record<string, unknown>; agent: string | null; ownerTokenId: string; startedAt: Date | null },
  now: Date,
  zone: string,
): string {
  const label = labelOf(r.params);
  const by = byText(r.agent, ownerName(db, r.ownerTokenId));
  return `running ${r.type}${label ? ` "${label}"` : ''}${by ? ` ${by}` : ''} since ${timeText(r.startedAt ?? now, now, zone)}`;
}
