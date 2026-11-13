import { fingerprint, generateToken, parseToken } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { createInvite, INVITE_TTL_MS, resolveToken } from '../src/domain/tokens.js';
import { PAIR_CRYPTO_JS } from '../src/http/pages/pair-script.js';
import { useTestApp } from './helpers.js';

const t = useTestApp();
const open = (id: string) => t.app.inject({ method: 'GET', url: `/pair/${id}` });
const scriptOf = (body: string) => /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(body);

type BrowserCrypto = { fornaxNewToken(name: string): string; fornaxFingerprint(token: string): Promise<string> };
const browser = new Function(`${PAIR_CRYPTO_JS}\nreturn { fornaxNewToken, fornaxFingerprint };`)() as BrowserCrypto;

describe('the token algorithm the page runs', () => {
  test('makes tokens of the protocol format, each with the protocol fingerprint', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const token = browser.fornaxNewToken('alice');
      expect(parseToken(token)).toEqual({ name: 'alice' });
      expect(await browser.fornaxFingerprint(token)).toBe(fingerprint(token));
      seen.add(token);
    }
    expect(seen.size).toBe(50);
  });

  test('fingerprints known tokens exactly like the protocol', async () => {
    for (const token of [`fornax-a-${'A'.repeat(43)}`, `fornax-alice-${'_'.repeat(43)}`, `fornax-z9-${'-'.repeat(21)}${'9'.repeat(22)}`, generateToken('pc')]) {
      expect(await browser.fornaxFingerprint(token), token).toBe(fingerprint(token));
    }
  });
});

describe('the pairing page', () => {
  test('a client invite: strict headers with a fresh nonce, one script, no way to send anything', async () => {
    const invite = createInvite(t.db, { name: 'alice', role: 'client' }, t.clock.now);
    const a = await open(invite.id);
    const b = await open(invite.id);
    expect(a.statusCode).toBe(200);
    const m = scriptOf(a.body)!;
    expect(a.headers).toMatchObject({
      'content-security-policy': `script-src 'nonce-${m[1]}'; default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'`,
      'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff',
      'content-type': 'text/html; charset=utf-8',
    });
    expect(scriptOf(b.body)![1]).not.toBe(m[1]);
    expect(a.body.match(/<script/g)).toHaveLength(1);
    expect(m[2]).not.toContain('</');
    expect(a.body).not.toMatch(/<form|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|src="http|href="http/);
    expect(a.body.replace(m[0], '')).not.toMatch(/\son[a-z]+\s*=/i);
    expect(a.body).toContain('alice');
  });

  test('the page script fills in the token, both setups and the fingerprint, touches no network API, and the token pairs', async () => {
    const invite = createInvite(t.db, { name: 'alice', role: 'client' }, t.clock.now);
    const script = scriptOf((await open(invite.id)).body)![2]!;
    const nodes = new Map<string, { textContent: string; hidden: boolean }>();
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: true });
      return nodes.get(id)!;
    };
    const document = { getElementById: node, querySelectorAll: () => [] };
    const network: string[] = [];
    const trap = (name: string) => () => {
      network.push(name);
      throw new Error(`${name} is not allowed`);
    };
    const run = new Function('document', 'window', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', `${script}\nreturn fornaxDone;`);
    const token = (await run(document, { isSecureContext: true }, trap('fetch'), trap('XMLHttpRequest'), trap('WebSocket'), trap('EventSource'))) as string;

    expect(network).toEqual([]);
    expect(parseToken(token)).toEqual({ name: 'alice' });
    expect(node('token').textContent).toBe(token);
    expect(node('claude-code').textContent).toBe(`claude mcp add fornax --scope user --transport http https://fornax.example.com/mcp --header "Authorization: Bearer ${token}"`);
    expect(node('connector').textContent).toBe(`https://fornax.example.com/mcp/${token}`);
    expect(node('fingerprint').textContent).toBe(fingerprint(token));
    expect(node('ready').hidden).toBe(false);
    // The first use of the token registers it, waiting for the admin, with the fingerprint the page showed.
    expect(resolveToken(t.db, token, t.clock.now)).toEqual({ kind: 'pending', fingerprint: node('fingerprint').textContent });
  });

  test('without a secure context the page says so and makes no token', async () => {
    const invite = createInvite(t.db, { name: 'alice', role: 'client' }, t.clock.now);
    const script = scriptOf((await open(invite.id)).body)![2]!;
    const nodes = new Map<string, { textContent: string; hidden: boolean }>();
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: true });
      return nodes.get(id)!;
    };
    const run = new Function('document', 'window', `${script}\nreturn fornaxDone;`);
    expect(await run({ getElementById: node, querySelectorAll: () => [] }, { isSecureContext: false })).toBeNull();
    expect(node('problem')).toEqual({ textContent: 'This page must be opened over HTTPS to make a token.', hidden: false });
    expect(nodes.has('token')).toBe(false);
  });

  test('used, expired and unknown invites all get the same neutral 404 page', async () => {
    const used = createInvite(t.db, { name: 'alice', role: 'client' }, t.clock.now);
    resolveToken(t.db, generateToken('alice'), t.clock.now);
    const expired = createInvite(t.db, { name: 'bob', role: 'client' }, t.clock.now);
    t.clock.advance(INVITE_TTL_MS + 1);
    const pages = [await open(used.id), await open(expired.id), await open('nope')];
    for (const p of pages) {
      expect(p.statusCode).toBe(404);
      expect(p.body).not.toContain('<script');
      expect(p.headers['referrer-policy']).toBe('no-referrer');
    }
    expect(new Set(pages.map((p) => p.body)).size).toBe(1);
    expect(pages[0]!.body).toContain('This invite is not valid');
  });

  test('a worker invite says to pair from the worker PC', async () => {
    const invite = createInvite(t.db, { name: 'pc', role: 'worker' }, t.clock.now);
    const p = await open(invite.id);
    expect(p.statusCode).toBe(200);
    expect(p.body).toContain('fornax worker pair --server https://fornax.example.com --name pc');
    expect(p.body).not.toContain('<script');
  });
});
