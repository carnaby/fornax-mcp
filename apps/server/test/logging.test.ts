import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { jobs } from '../src/db/schema.js';
import { jobFile } from '../src/domain/outputs.js';
import { createInvite } from '../src/domain/tokens.js';
import { FileStore } from '../src/files/store.js';
import { buildApp } from '../src/http/app.js';
import { downloadPath, resultPath } from '../src/http/links.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestDb } from './helpers.js';

const t = useTestDb();
const SECRET = 'SECRETVALUE';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(lines: string[]) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  try {
    app = await buildApp({ config: t.config, db: t.db, logStream: { write: (m) => void lines.push(m) } });
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
  return app;
}

describe('log masking', () => {
  test('secrets in URLs never reach the logs', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    const client = issueToken(t.db, 'alice', 'client');
    for (const [url, headers] of [
      [`/mcp/fornax-alice-${SECRET}`, {}],
      [`/api/whoami?sig=${SECRET}`, {}],
      [`/api/whoami?sig=${SECRET}`, { authorization: `Bearer ${client}` }],
      [`/api/uploads/${SECRET}.1.sig`, {}],
      [`/nope/${SECRET}`, {}],
    ] as const) {
      await a.inject({ method: 'GET', url, headers });
    }
    const out = lines.join('');
    expect(out).toContain('incoming request');
    expect(out).not.toContain(SECRET);
  });

  test('pairing pages never log the invite id, also when the path is percent-encoded', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    const invite = createInvite(t.db, { name: 'alice', role: 'client' }, new Date());
    const encoded = `/%70air/${invite.id}`;
    expect((await a.inject({ method: 'GET', url: `/pair/${invite.id}` })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: encoded })).statusCode).toBe(200);
    // The router decodes the other secret routes the same way.
    for (const url of [`/%6Dcp/fornax-alice-${SECRET}`, `/%72/${SECRET}.1.sig`, `/api/%75ploads/${SECRET}.1.sig`]) {
      await a.inject({ method: 'GET', url });
    }
    await a.inject({ method: 'PUT', url: `/api/%75ploads/${SECRET}.1.sig`, payload: 'x' });
    const out = lines.join('');
    expect(out).toContain('/pair/***');
    expect(out).not.toContain(invite.id);
    expect(out).not.toContain(SECRET);
  });

  test('query strings never reach the logs', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    const client = issueToken(t.db, 'alice', 'client');
    await a.inject({
      method: 'POST',
      url: `/api/files?name=${SECRET}.wav&group=${SECRET}`,
      headers: { authorization: `Bearer ${client}` },
      payload: 'x',
    });
    const out = lines.join('');
    expect(out).toContain('incoming request');
    expect(out).toContain('/api/files');
    expect(out).not.toContain(SECRET);
  });

  test('a failing handler answers 500 without details', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    a.get('/boom', async () => {
      throw new Error(`db failed for ${SECRET}`);
    });
    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'internal error' });
  });
});

describe('MCP transport errors', () => {
  test('an error inside the MCP transport is answered with a JSON-RPC error and logged as message and stack only', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    const alice = issueToken(t.db, 'alice');
    const spy = vi.spyOn(NodeStreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(new Error('transport broke'));
    try {
      const res = await a.inject({
        method: 'POST', url: `/mcp/${alice}`,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'ping', params: { secret: SECRET } },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    } finally {
      spy.mockRestore();
    }
    const failed = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'mcp request failed');
    expect(failed).toMatchObject({ level: 50, err: { message: 'transport broke', stack: expect.stringContaining('transport broke') } });
    expect(Object.keys(failed.err).sort()).toEqual(['message', 'stack', 'type']); // type: added by the logger
    const out = lines.join('');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(alice);
  });
});

describe('secrets on the agent surface', () => {
  test('MCP through the path, result pages, signed downloads and pairing pages keep their secrets out of the logs', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    announce(t.db, [renderContract], new Date());
    const alice = issueToken(t.db, 'alice');
    const worker = issueToken(t.db, 'pc', 'worker');
    const scene = await uploadFile(a, alice, 'scene.blend', 'B');
    const id = (await a.inject({ method: 'POST', url: '/api/jobs', headers: auth(alice), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } })).json().id as string;
    const lease = (await a.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(worker), payload: { wait: 0 } })).json().lease as string;
    await a.inject({
      method: 'PUT', url: `/api/worker/jobs/${id}/outputs/a.txt`,
      headers: { ...auth(worker), 'content-type': 'application/octet-stream', 'x-fornax-lease': lease }, payload: 'A',
    });
    await a.inject({ method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: auth(worker), payload: { lease } });

    const deps = { config: t.config, db: t.db, store: new FileStore(t.config.filesDir), clock: () => new Date() };
    const job = t.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    const result = resultPath(deps, job);
    const download = downloadPath(deps, job, jobFile(t.db, id, 'a.txt')!).path;
    const invite = createInvite(t.db, { name: 'bob', role: 'client' }, new Date());
    expect((await a.inject({ method: 'GET', url: result })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: download })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: `/pair/${invite.id}` })).statusCode).toBe(200);
    // Percent-encoded prefixes reach the same routes.
    const signed = result.slice('/r/'.length);
    for (const url of [`/%6Dcp/${alice}`, `/%72/${signed}`, `/api/%75ploads/${signed}`, `/%70air/${invite.id}`]) {
      await a.inject({ method: 'GET', url });
    }

    await a.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 'log-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(a.server.address() as AddressInfo).port}/mcp/${alice}`)));
    try {
      expect((await client.callTool({ name: 'list_jobs', arguments: {} })).isError).not.toBe(true);
    } finally {
      await client.close();
    }

    const out = lines.join('');
    for (const masked of ['/mcp/***', '/r/***', '/pair/***']) expect(out).toContain(masked);
    const secrets = [alice, alice.slice('fornax-alice-'.length), signed, new URL(download, 'http://x').searchParams.get('sig')!, invite.id];
    for (const secret of secrets) expect(out).not.toContain(secret);
  });
});
