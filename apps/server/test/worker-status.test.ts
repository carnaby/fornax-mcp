import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { workerState } from '../src/db/schema.js';
import { issueToken, useTestApp } from './helpers.js';

const t = useTestApp();
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const busy = { reason: 'gpu_busy', used_mib: 5120, total_mib: 16311, limit_mib: 2048 };
const BUSY_MESSAGE = 'waiting: 5120 MiB of 16311 MiB of the card in use by other programs, limit 2048 MiB';

function setup() {
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const status = (waiting: unknown, token = worker) =>
    t.app.inject({ method: 'PUT', url: '/api/worker/status', headers: as(token), payload: { waiting } });
  const queue = async () => (await t.app.inject({ method: 'GET', url: '/api/queue', headers: as(alice) })).json();
  return { worker, alice, status, queue };
}

test('the worker reports a busy card; clients see the reason with a ready sentence', async () => {
  const { alice, status, queue } = setup();
  expect((await status(busy)).statusCode).toBe(204);
  expect((await queue()).worker).toEqual({
    online: true,
    last_seen: t.clock.now.toISOString(),
    waiting: { reason: 'gpu_busy', message: BUSY_MESSAGE, used_mib: 5120, total_mib: 16311, limit_mib: 2048 },
  });
  const types = (await t.app.inject({ method: 'GET', url: '/api/types', headers: as(alice) })).json();
  expect(types.worker.waiting.message).toBe(BUSY_MESSAGE);
});

test('a card that cannot be read is reported with the error, flattened to one line', async () => {
  const { status, queue } = setup();
  await status({ reason: 'gpu_unreadable', error: 'nvidia-smi:\nnot found', limit_mib: 2048 });
  expect((await queue()).worker.waiting).toEqual({
    reason: 'gpu_unreadable',
    message: 'waiting: the worker cannot read the card (nvidia-smi: not found); no job starts until it can, asking again changes nothing',
    error: 'nvidia-smi: not found',
    limit_mib: 2048,
  });
});

test('a status is a sign of life; a worker silent for 90 s shows no reason', async () => {
  const { status, queue } = setup();
  await status(busy);
  t.clock.advance(60_000);
  await status(busy);
  t.clock.advance(60_000);
  expect((await queue()).worker).toMatchObject({ online: true, waiting: { reason: 'gpu_busy' } });
  t.clock.advance(31_000);
  expect((await queue()).worker).toMatchObject({ online: false, waiting: null });
});

test('waiting null clears the reason, and so does a claim', async () => {
  const { worker, status, queue } = setup();
  await status(busy);
  await status(null);
  expect((await queue()).worker.waiting).toBeNull();
  await status(busy);
  const claim = await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: as(worker), payload: { wait: 0 } });
  expect(claim.statusCode).toBe(204);
  expect((await queue()).worker.waiting).toBeNull();
  expect(t.db.select().from(workerState).where(eq(workerState.id, 1)).get()!.waiting).toBeNull();
});

test('only the worker token reports, and only in this shape', async () => {
  const { alice, status } = setup();
  expect((await status(busy, alice)).statusCode).toBe(401);
  expect((await status({ reason: 'tired', limit_mib: 1 })).statusCode).toBe(400);
  const other = issueToken(t.db, 'pc2', 'worker');
  expect((await t.app.inject({ method: 'PUT', url: '/api/worker/status', headers: as(other), payload: {} })).statusCode).toBe(400);
});
