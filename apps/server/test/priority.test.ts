import { beforeEach, describe, expect, test } from 'vitest';
import type { DomainError } from '../src/domain/errors.js';
import { getOwnJob, type JobRow, jobDetail, jobView, submitJob } from '../src/domain/jobs.js';
import { queueStatus } from '../src/domain/maintenance.js';
import { setJobPriority, startIdle } from '../src/domain/priority.js';
import { claimJob } from '../src/domain/queue.js';
import { moveJob, queueOrder } from '../src/domain/queue-order.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
let n = 0;
/** Like render, but its pack says default_priority: idle (spec 07 § 4.4). */
const batchContract = { ...renderContract, name: 'batch', default_priority: 'idle' };

beforeEach(() => {
  n = 0;
  announce(t.db, [renderContract, transcribeContract, batchContract], t.clock.now);
});

/** A job of a fresh owner (raw token for the upload, token id for the submit); priority left out when undefined. */
async function job(priority?: 'idle' | 'normal' | 'high', type: 'render' | 'batch' = 'render'): Promise<JobRow> {
  const owner = issueToken(t.db, `m${++n}`);
  const scene = await uploadFile(t.app, owner, 'scene.blend', 'B');
  const row = submitJob(t.db, t.config, tokenIdOf(t.db, `m${n}`), { type, params: { frame_start: 1 }, inputs: { scene }, ...(priority ? { priority } : {}) }, t.clock.now);
  t.clock.advance(1);
  return row;
}
const ids = (...rows: JobRow[]) => rows.map((r) => r.id);
const fresh = (row: JobRow) => getOwnJob(t.db, row.ownerTokenId, row.id);
function failure(fn: () => void): DomainError {
  try {
    fn();
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected an error');
}

describe('submit (spec 07 § 4.1, § 4.4)', () => {
  test('without a priority the type decides: batch is idle, render is normal', async () => {
    const b = await job(undefined, 'batch');
    const r = await job(undefined, 'render');
    expect(jobView(t.db, b).priority).toBe('idle');
    expect(jobView(t.db, r).priority).toBe('normal');
    expect(fresh(b).idleSince).toEqual(b.createdAt);
    expect(fresh(r).idleSince).toBeNull();
  });

  test('an explicit priority wins over the type', async () => {
    const b = await job('normal', 'batch');
    expect(jobView(t.db, b).priority).toBe('normal');
  });
});

describe('claim and position (spec 07 § 2.2)', () => {
  test('an idle job is skipped, even alone with a free card', async () => {
    await job('idle');
    expect(claimJob(t.db, t.clock.now)).toBeNull();
  });

  test('idle jobs moved above normal ones are still skipped (Review Focus 2)', async () => {
    const i1 = await job('idle');
    const n1 = await job('normal');
    moveJob(t.db, i1.id, { to: 'top' });
    expect(queueOrder(t.db)).toEqual(ids(i1, n1));
    expect(jobView(t.db, fresh(n1)).position).toBe(1);
    expect(jobView(t.db, fresh(i1)).position).toBeNull();
    expect(claimJob(t.db, t.clock.now)!.id).toBe(n1.id);
  });

  test('the note of an idle job says it waits for a person', async () => {
    const i1 = await job('idle');
    expect(jobDetail(t.db, t.config, fresh(i1), t.clock.now).note).toBe('this job is idle: it waits until the operator starts it or its owner changes its priority');
  });

  test('queue status counts idle jobs apart', async () => {
    await job('idle');
    await job('normal');
    expect(queueStatus(t.db, t.clock.now)).toMatchObject({ queued: 1, idle: 1 });
  });
});

describe('changing the priority (spec 07 § 2.3)', () => {
  test('places the job as if it were new', async () => {
    const h1 = await job('high');
    const n1 = await job('normal');
    const n2 = await job('normal');
    setJobPriority(t.db, n2.id, 'high', t.clock.now, null);
    expect(queueOrder(t.db)).toEqual(ids(h1, n2, n1));
    setJobPriority(t.db, h1.id, 'idle', t.clock.now, null);
    expect(queueOrder(t.db)).toEqual(ids(n2, n1, h1));
    expect(fresh(h1).idleSince).toEqual(t.clock.now);
    setJobPriority(t.db, h1.id, 'normal', t.clock.now, null);
    expect(queueOrder(t.db)).toEqual(ids(n2, n1, h1));
    expect(fresh(h1).idleSince).toBeNull();
  });

  test('the same priority again is a no-op (Review Focus 3)', async () => {
    const n1 = await job('normal');
    const n2 = await job('normal');
    setJobPriority(t.db, n1.id, 'normal', t.clock.now, null);
    expect(queueOrder(t.db)).toEqual(ids(n1, n2));
  });

  test('a client changes only its own waiting jobs: another owner 404, a running job 409', async () => {
    const mine = await job('normal');
    const other = await job('normal');
    expect(failure(() => setJobPriority(t.db, other.id, 'idle', t.clock.now, mine.ownerTokenId)).status).toBe(404);
    expect(failure(() => setJobPriority(t.db, 'nope', 'idle', t.clock.now, null)).status).toBe(404);
    claimJob(t.db, t.clock.now);
    expect(failure(() => setJobPriority(t.db, mine.id, 'idle', t.clock.now, mine.ownerTokenId)).status).toBe(409);
    setJobPriority(t.db, other.id, 'idle', t.clock.now, other.ownerTokenId);
    expect(jobView(t.db, fresh(other)).priority).toBe('idle');
  });
});

describe('Start all (spec 07 § 2.3)', () => {
  test('every idle job becomes normal at the end of the normal ones, in its order', async () => {
    const i1 = await job('idle');
    const i2 = await job('idle');
    const n1 = await job('normal');
    const h1 = await job('high');
    moveJob(t.db, i2.id, { before: i1.id });
    expect(startIdle(t.db, t.clock.now)).toBe(2);
    expect(queueOrder(t.db)).toEqual(ids(h1, n1, i2, i1));
    expect([fresh(i1), fresh(i2)].map((r) => jobView(t.db, r).priority)).toEqual(['normal', 'normal']);
    expect(startIdle(t.db, t.clock.now)).toBe(0);
  });
});
