import { exec } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { webhookKey } from '@fornax/protocol';
import sharp from 'sharp';
import { afterEach, expect, test } from 'vitest';
import { startTestServer } from '../src/testing.js';
import { renderContract } from './fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Block = { type: string; text?: string; data?: string; mimeType?: string };

async function waitFor<T>(fn: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The client app's webhook endpoint on 127.0.0.1. */
async function webhookReceiver() {
  const hits: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
    });
    req.on('end', () => {
      hits.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

test('an agent uploads and submits over MCP, a worker runs the job, the agent sees the image, the user opens the page, the app gets a signed webhook', async () => {
  const hooks = await webhookReceiver();
  const s = await startTestServer({ webhooks: { allowedPrefixes: [`${hooks.url}/hooks/`] } });
  cleanup.push(() => s.close());

  // The worker: its own token, announcing the render type.
  const worker = s.issueToken('pc', 'worker');
  const w = (path: string, init: { method: string; json?: unknown; body?: string | Uint8Array<ArrayBuffer>; lease?: string }) =>
    fetch(`${s.url}/api/worker${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${worker}`,
        'x-fornax-worker': 'gpu-pc',
        ...(init.lease ? { 'x-fornax-lease': init.lease } : {}),
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : init.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  expect((await w('/types', { method: 'PUT', json: { types: [renderContract] } })).status).toBe(200);

  // The agent: an MCP client with its own token in the header.
  const alice = s.issueToken('alice');
  const client = new Client({ name: 'e2e-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${alice}` } } }));
  cleanup.push(() => client.close());
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<Block[]> => {
    const r = await client.callTool({ name, arguments: args });
    const blocks = r.content as Block[];
    if (r.isError) throw new Error(`${name}: ${blocks[0]?.text}`);
    return blocks;
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await tool(name, args))[0]!.text!);

  expect((await json('list_job_types')).types.map((x: { name: string }) => x.name)).toEqual(['render']);
  const upload = await json('create_upload', { name: 'scene.blend' });
  expect(upload.curl).toContain(`-T "<path>"`);
  // The agent runs the command it got, with its local file in place of <path>: one streamed PUT, no token.
  const dir = await mkdtemp(join(tmpdir(), 'fornax-e2e-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const scene = join(dir, 'scene.blend');
  await writeFile(scene, 'BLENDER');
  const sent = await promisify(exec)(upload.curl.replace('<path>', scene));
  expect(JSON.parse(sent.stdout)).toMatchObject({ id: upload.file_id, name: 'scene.blend', size: 7 });
  const { job_id } = await json('submit_job', { type: 'render', params: { frame_start: 1 }, inputs: { scene: upload.file_id }, callback_url: `${hooks.url}/hooks/render` });

  // The worker runs it: claim, input, progress, outputs, complete.
  const claim = await (await w('/jobs/claim', { method: 'POST', json: { wait: 5 } })).json();
  expect(claim).toMatchObject({ id: job_id, type: 'render', params: { frame_start: 1, samples: 128 } });
  expect(await (await w(`/jobs/${job_id}/inputs/scene`, { method: 'GET', lease: claim.lease })).text()).toBe('BLENDER');
  await w(`/jobs/${job_id}/heartbeat`, { method: 'POST', json: { lease: claim.lease, progress: 0.5, message: 'frame 1/1' } });
  expect(await json('get_job', { job_id })).toMatchObject({ state: 'running', progress: 0.5, progress_message: 'frame 1/1' });
  const png = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 30, g: 90, b: 200 } } }).png().toBuffer();
  expect((await w(`/jobs/${job_id}/outputs/frame_0001.png`, { method: 'PUT', body: new Uint8Array(png), lease: claim.lease })).status).toBe(201);
  expect((await w(`/jobs/${job_id}/outputs/log.txt?kind=log`, { method: 'PUT', body: 'Fra:1 done', lease: claim.lease })).status).toBe(201);
  const complete = await w(`/jobs/${job_id}/complete`, { method: 'POST', json: { lease: claim.lease, outputs: { 'frame_0001.png': { meta: { width: 1920, height: 1080 } } } } });
  expect(complete.status).toBe(200);

  // The agent sees the result, with the preview as image content.
  const done = await json('get_job', { job_id });
  expect(done).toMatchObject({
    state: 'succeeded', log: 'log.txt',
    outputs: [{ name: 'frame_0001.png', mime: 'image/png', preview: '.fornax/previews/frame_0001.png.jpg', meta: { width: 1920, height: 1080 } }],
  });
  const [info, image] = await tool('get_output', { job_id, name: 'frame_0001.png' });
  expect(image).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  expect(await sharp(Buffer.from(image!.data!, 'base64')).metadata()).toMatchObject({ format: 'jpeg', width: 1024, height: 576 });
  const original = await fetch(JSON.parse(info!.text!).download_url);
  expect(original.status).toBe(200);
  expect(Buffer.from(await original.arrayBuffer()).equals(png)).toBe(true);
  expect((await tool('get_output', { job_id, name: 'log.txt' }))[1]).toEqual({ type: 'text', text: 'Fra:1 done' });

  // The user opens the result page from get_job.
  const page = await fetch(done.result_url);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  const body = await page.text();
  expect(body).toContain('alt="frame_0001.png"');
  expect(body).not.toContain('http-equiv="refresh"');
  const img = /<img src="([^"]+)"/.exec(body)![1]!.replaceAll('&amp;', '&');
  expect((await fetch(`${s.url}${img}`)).headers.get('content-type')).toBe('image/jpeg');

  // The app gets the webhook from the delivery loop and checks it with the key derived from its own token.
  const hit = await waitFor(() => hooks.hits[0], 'the webhook');
  expect(hit.url).toBe('/hooks/render');
  expect(JSON.parse(hit.body)).toEqual({ job_id, state: 'succeeded' });
  const ts = String(hit.headers['x-fornax-timestamp']);
  expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60);
  expect(hit.headers['x-fornax-signature']).toBe(`sha256=${createHmac('sha256', webhookKey(alice)).update(`${ts}.${hit.body}`).digest('hex')}`);
});
