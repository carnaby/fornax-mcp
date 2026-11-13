import { fingerprint, generateToken, webhookKey } from '@fornax/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { invites, tokens } from '../src/db/schema.js';
import { approveToken, createInvite, listTokens, resolveToken, revokeToken } from '../src/domain/tokens.js';
import { useTestDb } from './helpers.js';

const t = useTestDb();
const now = new Date('2026-11-13T10:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);

describe('tokens', () => {
  test('first use of an invite registers a pending token with its fingerprint', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    const raw = generateToken('alice');
    expect(resolveToken(t.db, raw, now)).toEqual({ kind: 'pending', fingerprint: fingerprint(raw), role: 'client' });
    expect(resolveToken(t.db, raw, now)).toEqual({ kind: 'pending', fingerprint: fingerprint(raw), role: 'client' });
    expect(t.db.select().from(tokens).all()).toHaveLength(1);
  });

  test('a token without an invite is refused and nothing is stored', () => {
    expect(resolveToken(t.db, generateToken('eve'), now)).toBeNull();
    expect(t.db.select().from(tokens).all()).toHaveLength(0);
  });

  test('malformed tokens are refused', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    expect(resolveToken(t.db, 'fornax-alice-short', now)).toBeNull();
  });

  test('an expired invite is refused', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    expect(resolveToken(t.db, generateToken('alice'), later(86_400_001))).toBeNull();
  });

  test('a second invite is refused while the first is unused and unexpired', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    expect(() => createInvite(t.db, { name: 'alice', role: 'client' }, later(1000))).toThrow(/invite/);
    expect(() => createInvite(t.db, { name: 'alice', role: 'client' }, later(86_400_001))).not.toThrow();
  });

  test('no second pending token is registered for a name that already has one', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    const first = generateToken('alice');
    resolveToken(t.db, first, now);
    // A second unused invite for the same name, inserted directly (createInvite refuses it).
    t.db.insert(invites).values({ id: 'second', name: 'alice', role: 'client', expiresAt: later(86_400_000), createdAt: now }).run();
    expect(resolveToken(t.db, generateToken('alice'), now)).toBeNull();
    expect(t.db.select().from(tokens).all()).toHaveLength(1);
  });

  test('one invite gives one token', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    resolveToken(t.db, generateToken('alice'), now);
    expect(resolveToken(t.db, generateToken('alice'), now)).toBeNull();
  });

  test('a second invite for a name with a pending token is refused', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    resolveToken(t.db, generateToken('alice'), now);
    expect(() => createInvite(t.db, { name: 'alice', role: 'client' }, now)).toThrow(/waiting for approval/);
  });

  test('approve activates; revoke ends it', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    const raw = generateToken('alice');
    resolveToken(t.db, raw, now);
    expect(approveToken(t.db, 'alice', now)).toEqual({ name: 'alice', role: 'client', fingerprint: fingerprint(raw) });
    const r = resolveToken(t.db, raw, later(1000));
    expect(r?.kind).toBe('active');
    if (r?.kind === 'active') expect(r.identity).toMatchObject({ name: 'alice', role: 'client' });
    expect(revokeToken(t.db, 'alice')).toBe(1);
    expect(resolveToken(t.db, raw, later(2000))).toBeNull();
  });

  test('approving a new worker token revokes the previous one', () => {
    createInvite(t.db, { name: 'pc', role: 'worker' }, now);
    const first = generateToken('pc');
    resolveToken(t.db, first, now);
    approveToken(t.db, 'pc', now);
    createInvite(t.db, { name: 'pc2', role: 'worker' }, now);
    const second = generateToken('pc2');
    resolveToken(t.db, second, now);
    approveToken(t.db, 'pc2', now);
    expect(resolveToken(t.db, first, now)).toBeNull();
    expect(resolveToken(t.db, second, now)?.kind).toBe('active');
  });

  test('client tokens store the derived webhook key; worker tokens none', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    const raw = generateToken('alice');
    resolveToken(t.db, raw, now);
    const row = t.db.select().from(tokens).where(eq(tokens.name, 'alice')).get();
    expect(row?.webhookKey).toBe(webhookKey(raw).toString('hex'));
  });

  test('approve and revoke of unknown names are 404', () => {
    expect(() => approveToken(t.db, 'nobody', now)).toThrow(/no token named nobody/);
    expect(() => revokeToken(t.db, 'nobody')).toThrow(/no token named nobody/);
  });

  test('list shows names, roles, states and fingerprints but no hashes', () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, now);
    resolveToken(t.db, generateToken('alice'), now);
    const [row] = listTokens(t.db);
    expect(row).toMatchObject({ name: 'alice', role: 'client', status: 'pending' });
    expect(row).not.toHaveProperty('hash');
  });
});
