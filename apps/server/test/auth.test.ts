import { fingerprint, generateToken } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { createInvite, resolveToken } from '../src/domain/tokens.js';
import { logUrl, maskUrl } from '../src/http/app.js';
import { issueToken, useTestApp } from './helpers.js';

const t = useTestApp();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('authentication', () => {
  test('no token, a malformed token and an unknown token are 401', async () => {
    for (const headers of [{}, bearer('nope'), bearer(generateToken('eve'))]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/whoami', headers });
      expect(res.statusCode).toBe(401);
    }
  });

  test('a pending token gets 403 with its fingerprint', async () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, t.clock.now);
    const raw = generateToken('alice');
    const res = await t.app.inject({ method: 'GET', url: '/api/whoami', headers: bearer(raw) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'pending', message: `this token is waiting for approval; fingerprint ${fingerprint(raw)}` });
    expect(resolveToken(t.db, raw, t.clock.now)?.kind).toBe('pending');
  });

  test('roles do not cross', async () => {
    const client = issueToken(t.db, 'alice', 'client', t.clock.now);
    const worker = issueToken(t.db, 'pc', 'worker', t.clock.now);
    expect((await t.app.inject({ method: 'GET', url: '/api/whoami', headers: bearer(client) })).json()).toEqual({ name: 'alice', role: 'client' });
    expect((await t.app.inject({ method: 'GET', url: '/api/whoami', headers: bearer(worker) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/worker/ping', headers: bearer(worker) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/worker/ping', headers: bearer(client) })).statusCode).toBe(401);
  });

  test('unknown routes are 404 without echoing the URL', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope/fornax-secret' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('fornax-secret');
  });
});

describe('maskUrl', () => {
  test('hides tokens in /mcp paths, upload links, result links, invite ids and signatures', () => {
    expect(maskUrl('/mcp/fornax-alice-abc')).toBe('/mcp/***');
    expect(maskUrl('/api/uploads/abc.123.sig')).toBe('/api/uploads/***');
    expect(maskUrl('/r/abc.123.sig')).toBe('/r/***');
    expect(maskUrl('/api/jobs/1/outputs/a.png?sig=xyz&x=1')).toBe('/api/jobs/1/outputs/a.png?sig=***&x=1');
    expect(maskUrl('/mcp/tok/extra')).toBe('/mcp/***');
    expect(maskUrl('/mcp/tok?x=1')).toBe('/mcp/***?x=1');
    expect(maskUrl('/api/jobs/1?SIG=x')).toBe('/api/jobs/1?SIG=***');
    expect(maskUrl('//mcp/tok')).toBe('/mcp/***');
    expect(maskUrl('/pair/abcDEF_-123')).toBe('/pair/***');
    expect(maskUrl('/pair/abc?x=1')).toBe('/pair/***?x=1');
  });
});

describe('logUrl', () => {
  const req = (url: string, route?: string) => ({ url, is404: route === undefined, routeOptions: { url: route } });
  test('logs a secret route as its masked template, also when the path was percent-encoded', () => {
    expect(logUrl(req('/%70air/abc', '/pair/:invite'))).toBe('/pair/***');
    expect(logUrl(req('/%6Dcp/fornax-alice-abc', '/mcp/:token'))).toBe('/mcp/***');
    expect(logUrl(req('/%72/abc.1.sig', '/r/:signed'))).toBe('/r/***');
    expect(logUrl(req('/api/%75ploads/abc.1.sig', '/api/uploads/:signed'))).toBe('/api/uploads/***');
  });

  test('keeps the path of other routes without the query, and logs no unmatched URL', () => {
    expect(logUrl(req('/api/jobs/j1?x=secret', '/api/jobs/:id'))).toBe('/api/jobs/j1');
    expect(logUrl(req('/api/jobs/j1/outputs/a.png?sig=x', '/api/jobs/:id/outputs/*'))).toBe('/api/jobs/j1/outputs/a.png');
    expect(logUrl(req('/nope/secret'))).toBe('(unmatched)');
  });
});
