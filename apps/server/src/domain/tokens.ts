import { randomBytes, randomUUID } from 'node:crypto';
import { fingerprint, parseToken, TOKEN_NAME, type TokenRole, tokenHash, webhookKey } from '@fornax/protocol';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { invites, tokens } from '../db/schema.js';
import { badRequest, conflict, notFound } from './errors.js';

export const INVITE_TTL_MS = 86_400_000;

export type Identity = { tokenId: string; name: string; role: TokenRole };
export type Resolved = { kind: 'active'; identity: Identity } | { kind: 'pending'; fingerprint: string } | null;

export function createInvite(db: Db, input: { name: string; role: TokenRole }, now: Date): { id: string; expiresAt: Date } {
  if (!TOKEN_NAME.test(input.name)) throw badRequest('the name must be 1-24 characters a-z or 0-9');
  const pending = db.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.name, input.name), eq(tokens.status, 'pending'))).get();
  if (pending) throw conflict(`a token named ${input.name} is waiting for approval; approve or revoke it first`);
  const open = db.select({ id: invites.id }).from(invites).where(and(eq(invites.name, input.name), isNull(invites.tokenId), gt(invites.expiresAt, now))).get();
  if (open) throw conflict(`an unused invite for ${input.name} already exists; wait for it to be used or to expire`);
  const id = randomBytes(16).toString('base64url');
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  db.insert(invites).values({ id, name: input.name, role: input.role, expiresAt, createdAt: now }).run();
  return { id, expiresAt };
}

/**
 * Who holds this token. An unknown token in the right format becomes a pending token when an unused, unexpired invite
 * with its name exists; otherwise it is refused and nothing is stored.
 */
export function resolveToken(db: Db, raw: string, now: Date): Resolved {
  const parsed = parseToken(raw);
  if (!parsed) return null;
  const hash = tokenHash(raw);
  return db.transaction((tx): Resolved => {
    const row = tx.select().from(tokens).where(eq(tokens.hash, hash)).get();
    if (row) {
      if (row.status === 'active') {
        tx.update(tokens).set({ lastSeenAt: now }).where(eq(tokens.id, row.id)).run();
        return { kind: 'active', identity: { tokenId: row.id, name: row.name, role: row.role } };
      }
      return row.status === 'pending' ? { kind: 'pending', fingerprint: row.fingerprint } : null;
    }
    const invite = tx
      .select()
      .from(invites)
      .where(and(eq(invites.name, parsed.name), isNull(invites.tokenId), gt(invites.expiresAt, now)))
      .orderBy(desc(invites.createdAt))
      .limit(1)
      .get();
    if (!invite) return null;
    // Two pending tokens with one name would make `approve <name>` ambiguous.
    const waiting = tx.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.name, parsed.name), eq(tokens.status, 'pending'))).get();
    if (waiting) return null;
    const id = randomUUID();
    const fp = fingerprint(raw);
    tx.insert(tokens)
      .values({
        id,
        name: parsed.name,
        role: invite.role,
        hash,
        fingerprint: fp,
        webhookKey: invite.role === 'client' ? webhookKey(raw).toString('hex') : null,
        status: 'pending',
        inviteId: invite.id,
        createdAt: now,
      })
      .run();
    tx.update(invites).set({ tokenId: id }).where(eq(invites.id, invite.id)).run();
    return { kind: 'pending', fingerprint: fp };
  });
}

export function approveToken(db: Db, name: string, now: Date): { name: string; role: TokenRole; fingerprint: string } {
  return db.transaction((tx) => {
    const row = tx.select().from(tokens).where(and(eq(tokens.name, name), eq(tokens.status, 'pending'))).get();
    if (!row) throw notFound(`no token named ${name} is waiting for approval`);
    // One worker: a newly approved worker token replaces the previous one.
    if (row.role === 'worker') {
      tx.update(tokens)
        .set({ status: 'revoked' })
        .where(and(eq(tokens.role, 'worker'), eq(tokens.status, 'active'), ne(tokens.id, row.id)))
        .run();
    }
    tx.update(tokens).set({ status: 'active', approvedAt: now }).where(eq(tokens.id, row.id)).run();
    return { name: row.name, role: row.role, fingerprint: row.fingerprint };
  });
}

export function revokeToken(db: Db, name: string): number {
  const rows = db
    .update(tokens)
    .set({ status: 'revoked' })
    .where(and(eq(tokens.name, name), ne(tokens.status, 'revoked')))
    .returning({ id: tokens.id })
    .all();
  if (!rows.length) throw notFound(`no token named ${name}`);
  return rows.length;
}

export function listTokens(db: Db) {
  return db
    .select({
      name: tokens.name,
      role: tokens.role,
      status: tokens.status,
      fingerprint: tokens.fingerprint,
      createdAt: tokens.createdAt,
      lastSeenAt: tokens.lastSeenAt,
    })
    .from(tokens)
    .orderBy(tokens.name, tokens.createdAt)
    .all();
}

/** Signed links act for their owner: they work only while the owner's token is active. */
export function ownerActive(db: Db, tokenId: string): boolean {
  return db.select({ status: tokens.status }).from(tokens).where(eq(tokens.id, tokenId)).get()?.status === 'active';
}
