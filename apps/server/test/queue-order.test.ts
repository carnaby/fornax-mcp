import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { openDb } from '../src/db/client.js';
import { jobs } from '../src/db/schema.js';
import type { DomainError } from '../src/domain/errors.js';
import { getOwnJob, type JobRow, jobView, submitJob } from '../src/domain/jobs.js';
import { abandonRunning, claimJob, expireLeases, failJob, LEASE_MS, releaseJob } from '../src/domain/queue.js';
import { moveJob, placeJob, queueOrder, repairQueueRanks } from '../src/domain/queue-order.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
let n = 0;
const paintContract = { ...renderContract, name: 'paint' };

beforeEach(() => {
  n = 0;
  announce(t.db, [renderContract, transcribeContract, paintContract], t.clock.now);
});

/** A render (or paint) job of a fresh owner; the clock moves on, so jobs are ordered by age. */
async function job(priority: 'idle' | 'normal' | 'high' = 'normal', type: 'render' | 'paint' = 'render'): Promise<JobRow> {
  const owner = issueToken(t.db, `m${++n}`);
  const scene = await uploadFile(t.app, owner, 'scene.blend', 'B');
  const row = submitJob(t.db, t.config, tokenIdOf(t.db, `m${n}`), { type, params: { frame_start: 1 }, inputs: { scene }, priority }, t.clock.now);
  t.clock.advance(1);
  return row;
}
const ids = (...rows: JobRow[]) => rows.map((r) => r.id);
const fresh = (row: JobRow) => getOwnJob(t.db, row.ownerTokenId, row.id);
const ranks = () =>
  t.db.select({ rank: jobs.queueRank }).from(jobs).where(eq(jobs.state, 'queued')).all().map((r) => r.rank).sort((a, b) => a! - b!);

function failure(fn: () => void): DomainError {
  try {
    fn();
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected an error');
}

describe('a new job is placed (spec 06 2.1.2)', () => {
  test('without moves the order is priority, then age', async () => {
    const n1 = await job('normal');
    const h1 = await job('high');
    const l1 = await job('idle');
    const n2 = await job('normal');
    expect(queueOrder(t.db)).toEqual(ids(h1, n1, n2, l1));
  });

  test('after a move it goes right after the last waiting job of its priority or higher', async () => {
    const n1 = await job('normal');
    const h1 = await job('high');
    const l1 = await job('idle');
    moveJob(t.db, h1.id, { after: n1.id });
    expect(queueOrder(t.db)).toEqual(ids(n1, h1, l1));
    const n2 = await job('normal');
    expect(queueOrder(t.db)).toEqual(ids(n1, h1, n2, l1));
    const h2 = await job('high');
    expect(queueOrder(t.db)).toEqual(ids(n1, h1, h2, n2, l1));
    const l2 = await job('idle');
    expect(queueOrder(t.db)).toEqual(ids(n1, h1, h2, n2, l1, l2));
  });

  test('with nothing of its priority or higher waiting it goes to the top', async () => {
    const n1 = await job('normal');
    const l1 = await job('idle');
    const h1 = await job('high');
    expect(queueOrder(t.db)).toEqual(ids(h1, n1, l1));
  });

  test('submit answers with the place already set', async () => {
    await job('normal');
    const h = await job('high');
    expect(jobView(t.db, h).position).toBe(1);
  });
});

describe('moving (spec 06 2.1.4)', () => {
  test('top, bottom, before and after; the ranks stay 1..n', async () => {
    const a = await job();
    const b = await job();
    const c = await job();
    const d = await job();
    moveJob(t.db, d.id, { to: 'top' });
    expect(queueOrder(t.db)).toEqual(ids(d, a, b, c));
    moveJob(t.db, d.id, { to: 'bottom' });
    expect(queueOrder(t.db)).toEqual(ids(a, b, c, d));
    moveJob(t.db, a.id, { before: d.id });
    expect(queueOrder(t.db)).toEqual(ids(b, c, a, d));
    moveJob(t.db, b.id, { after: a.id });
    expect(queueOrder(t.db)).toEqual(ids(c, a, b, d));
    expect(ranks()).toEqual([1, 2, 3, 4]);
  });

  test('only waiting jobs move: running is 409, unknown 404, itself 400', async () => {
    const a = await job();
    const b = await job();
    claimJob(t.db, t.clock.now);
    expect(failure(() => moveJob(t.db, a.id, { to: 'top' }))).toMatchObject({ status: 409, message: `job ${a.id} is running now; only waiting jobs move` });
    expect(failure(() => moveJob(t.db, b.id, { before: a.id }))).toMatchObject({ status: 409, message: `job ${a.id} is running now; only waiting jobs move` });
    expect(failure(() => moveJob(t.db, 'nope', { to: 'top' }))).toMatchObject({ status: 404, message: 'job nope not found' });
    expect(failure(() => moveJob(t.db, b.id, { after: 'nope' }))).toMatchObject({ status: 404, message: 'job nope not found' });
    expect(failure(() => moveJob(t.db, b.id, { after: b.id }))).toMatchObject({ status: 400, message: 'a job cannot move before or after itself' });
  });

  test('a finished job does not move', async () => {
    const a = await job();
    t.db.update(jobs).set({ state: 'canceled' }).where(eq(jobs.id, a.id)).run();
    expect(failure(() => moveJob(t.db, a.id, { to: 'top' }))).toMatchObject({ status: 409, message: `job ${a.id} is canceled; only waiting jobs move` });
  });
});

describe('claim and position follow the order', () => {
  test('the claim takes the first job in the order', async () => {
    const a = await job('high');
    const b = await job('normal');
    moveJob(t.db, b.id, { to: 'top' });
    expect(claimJob(t.db, t.clock.now)?.id).toBe(b.id);
    expect(claimJob(t.db, t.clock.now)?.id).toBe(a.id);
  });

  test('a job of a withdrawn type keeps its place but is skipped', async () => {
    const a = await job('normal', 'paint');
    const b = await job('normal');
    const c = await job('normal');
    announce(t.db, [renderContract, transcribeContract], t.clock.now);
    expect(jobView(t.db, fresh(a)).position).toBeNull();
    expect(jobView(t.db, fresh(b)).position).toBe(1);
    moveJob(t.db, c.id, { before: a.id });
    expect(queueOrder(t.db)).toEqual(ids(c, a, b));
    expect(jobView(t.db, fresh(c)).position).toBe(1);
    expect(claimJob(t.db, t.clock.now)?.id).toBe(c.id);
    expect(claimJob(t.db, t.clock.now)?.id).toBe(b.id);
    expect(queueOrder(t.db)).toEqual(ids(a));
  });
});

describe('a job that ran goes back to the top (spec 06 2.1.3)', () => {
  async function running() {
    const a = await job();
    const b = await job();
    const c = await job();
    const claimed = claimJob(t.db, t.clock.now)!;
    expect(claimed.id).toBe(a.id);
    moveJob(t.db, c.id, { to: 'top' });
    return { a, b, c, lease: claimed.leaseId! };
  }

  test('released by a stopping worker', async () => {
    const { a, b, c, lease } = await running();
    releaseJob(t.db, a.id, lease, t.clock.now);
    expect(queueOrder(t.db)).toEqual(ids(a, c, b));
  });

  test('a failed attempt: at the top, but skipped until its retry time', async () => {
    const { a, b, c, lease } = await running();
    failJob(t.db, a.id, lease, { error: 'boom', permanent: false }, t.clock.now);
    expect(queueOrder(t.db)).toEqual(ids(a, c, b));
    expect(claimJob(t.db, t.clock.now)?.id).toBe(c.id);
  });

  test('abandoned by a worker that asked again', async () => {
    const { a, b, c } = await running();
    abandonRunning(t.db, t.clock.now);
    expect(queueOrder(t.db)).toEqual(ids(a, c, b));
  });

  test('its lease ran out', async () => {
    const { a, b, c } = await running();
    expireLeases(t.db, new Date(t.clock.now.getTime() + LEASE_MS + 1));
    expect(queueOrder(t.db)).toEqual(ids(a, c, b));
  });
});

describe('repair (spec 06 2.1)', () => {
  test('waiting jobs without a rank go to the end, by priority then age', async () => {
    const a = await job('normal');
    const b = await job('idle');
    const c = await job('high');
    const d = await job('normal');
    t.db.update(jobs).set({ queueRank: null }).where(eq(jobs.id, b.id)).run();
    t.db.update(jobs).set({ queueRank: null }).where(eq(jobs.id, d.id)).run();
    expect(queueOrder(t.db)).toEqual(ids(c, a));
    expect(repairQueueRanks(t.db)).toBe(2);
    expect(queueOrder(t.db)).toEqual(ids(c, a, d, b));
    expect(ranks()).toEqual([1, 2, 3, 4]);
    expect(repairQueueRanks(t.db)).toBe(0);
  });

  test('opening the database repairs the ranks', async () => {
    const a = await job('idle');
    const b = await job('high');
    t.db.update(jobs).set({ queueRank: null }).run();
    const again = openDb(t.config.dbFile);
    again.close();
    expect(queueOrder(t.db)).toEqual(ids(b, a));
  });
});

describe('class-top (spec 07 § 2.3)', () => {
  test('right after the last waiting job of a higher priority, before its own priority', async () => {
    const h1 = await job('high');
    const n1 = await job('normal');
    const i1 = await job('idle');
    const x = await job('normal');
    placeJob(t.db, x.id, 'class-top');
    expect(queueOrder(t.db)).toEqual(ids(h1, x, n1, i1));
    t.db.update(jobs).set({ priority: 0 }).where(eq(jobs.id, x.id)).run();
    placeJob(t.db, x.id, 'class-top');
    expect(queueOrder(t.db)).toEqual(ids(h1, n1, x, i1));
  });
});
