import { FORNAX_VERSION } from '@fornax/protocol';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { files, jobInputs, jobs } from '../src/db/schema.js';
import type { DomainError } from '../src/domain/errors.js';
import { cancelAnyJob, type JobRow, submitJob } from '../src/domain/jobs.js';
import { OPERATOR_FINISHED, operatorQueue } from '../src/domain/operator.js';
import { claimJob, failJob, heartbeatJob } from '../src/domain/queue.js';
import { setQueuePaused } from '../src/domain/queue-control.js';
import { moveJob } from '../src/domain/queue-order.js';
import { touchWorker } from '../src/domain/worker-state.js';
import { leaseContract, renderContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const labelled = { ...leaseContract, params: { ...leaseContract.params, properties: { ...leaseContract.params.properties, label: { type: 'string', maxLength: 40 } } } };
let calls = 0;
const urlOf = (job: JobRow) => `https://fornax.example.com/r/${job.id}-${++calls}`;
const view = () => operatorQueue(t.db, t.clock.now, urlOf);

beforeEach(() => {
  announce(t.db, [renderContract, labelled], t.clock.now);
  issueToken(t.db, 'alice');
  issueToken(t.db, 'bob');
});

/** A render job of a second token of `owner` (named `<owner>2`): an input file can only be used by its uploader. */
async function render(owner: 'alice' | 'bob' = 'alice'): Promise<JobRow> {
  const raw = issueToken(t.db, `${owner}2`);
  const scene = await uploadFile(t.app, raw, 'scene.blend', 'B');
  const row = submitJob(t.db, t.config, tokenIdOf(t.db, `${owner}2`), { type: 'render', params: { frame_start: 1 }, inputs: { scene } }, t.clock.now);
  t.clock.advance(1);
  return row;
}
function lease(label: string): JobRow {
  const row = submitJob(t.db, t.config, tokenIdOf(t.db, 'bob'), { type: 'lease', params: { minutes: 5, label }, inputs: {} }, t.clock.now);
  t.clock.advance(1);
  return row;
}

describe('operatorQueue (spec 06 2.3)', () => {
  test('running, waiting in order and finished jobs of every owner, with names and links', async () => {
    const r = await render('alice');
    const l = lease('chrome');
    const claimed = claimJob(t.db, t.clock.now)!;
    expect(claimed.id).toBe(r.id);
    heartbeatJob(t.db, r.id, claimed.leaseId!, { progress: 0.62, message: 'encoding batch 2/4' }, t.clock.now);
    touchWorker(t.db, { tokenId: 'w', hostname: 'pc', version: '0.5.0' }, t.clock.now);

    const q = view();
    expect(q.server_time).toBe(t.clock.now.toISOString());
    expect(q.server_version).toBe(FORNAX_VERSION);
    expect(q.change).toMatch(/^[0-9a-f]{16}$/);
    expect(q).toMatchObject({ paused: false, worker: { online: true, version: '0.5.0', waiting: null }, finished: [] });
    expect(q.running).toMatchObject({
      id: r.id, type: 'render', owner: 'alice2', state: 'running', label: null, priority: 'normal',
      inputs: { scene: 'scene.blend' }, attempts: 1, progress: 0.62, progress_message: 'encoding batch 2/4', error: null,
      result_url: expect.stringContaining(`/r/${r.id}-`),
    });
    expect(q.queued.map((j) => j.id)).toEqual([l.id]);
    expect(q.queued[0]).toMatchObject({ owner: 'bob', label: 'chrome', inputs: {}, type_unavailable: false, run_after: null });
  });

  test('a waiting job whose type is withdrawn says so; an input whose file is gone shows null (deferred 06a)', async () => {
    const r = await render('alice');
    const l = lease('chrome');
    announce(t.db, [renderContract], t.clock.now);
    const scene = r.inputs.scene!;
    t.db.delete(jobInputs).where(eq(jobInputs.fileId, scene)).run();
    t.db.delete(files).where(eq(files.id, scene)).run();
    const q = view();
    expect(q.queued.find((j) => j.id === l.id)).toMatchObject({ type_unavailable: true });
    expect(q.queued.find((j) => j.id === r.id)).toMatchObject({ type_unavailable: false, inputs: { scene: null } });
  });

  test('a waiting job after a failed attempt shows its retry time', async () => {
    const r = await render('alice');
    const claimed = claimJob(t.db, t.clock.now)!;
    failJob(t.db, r.id, claimed.leaseId!, { error: 'boom', permanent: false }, t.clock.now);
    expect(view().queued[0]).toMatchObject({ id: r.id, run_after: new Date(t.clock.now.getTime() + 60_000).toISOString(), error: 'boom' });
  });

  test('finished jobs: newest first, at most 50', () => {
    // Canceled one by one: a token may have at most 50 open jobs.
    const made: JobRow[] = [];
    for (let i = 0; i < OPERATOR_FINISHED + 2; i++) {
      const j = lease(`l${i}`);
      cancelAnyJob(t.db, j.id, t.clock.now);
      t.clock.advance(1);
      made.push(j);
    }
    const q = view();
    expect(q.finished).toHaveLength(OPERATOR_FINISHED);
    expect(q.finished[0]!.id).toBe(made.at(-1)!.id);
    expect(q.finished[0]).toMatchObject({ state: 'canceled', finished_at: expect.any(String) });
  });

  test('the order follows moves; a paused queue says so', () => {
    const a = lease('a');
    const b = lease('b');
    moveJob(t.db, b.id, { to: 'top' });
    setQueuePaused(t.db, true, t.clock.now);
    const q = view();
    expect(q.queued.map((j) => j.id)).toEqual([b.id, a.id]);
    expect(q.paused).toBe(true);
  });

  test('a paused queue says since when: a second pause keeps the first time, a resume clears it', () => {
    expect(view().paused_at).toBeNull();
    const first = t.clock.now;
    setQueuePaused(t.db, true, first);
    t.clock.advance(5000);
    setQueuePaused(t.db, true, t.clock.now);
    expect(view().paused_at).toBe(first.toISOString());
    const before = view().change;
    setQueuePaused(t.db, false, t.clock.now);
    expect(view().paused_at).toBeNull();
    t.clock.advance(5000);
    setQueuePaused(t.db, true, t.clock.now);
    // A pause made again after a resume is another pause: the tray must not take it for the one it made.
    expect(view().paused_at).toBe(t.clock.now.toISOString());
    expect(view().change).not.toBe(before);
  });

  test('the change ignores time, last_seen and result links', async () => {
    const r = await render('alice');
    const claimed = claimJob(t.db, t.clock.now)!;
    touchWorker(t.db, { tokenId: 'w', hostname: 'pc', version: null }, t.clock.now);
    const before = view().change;
    t.clock.advance(5000);
    touchWorker(t.db, { tokenId: 'w', hostname: 'pc', version: null }, t.clock.now);
    heartbeatJob(t.db, r.id, claimed.leaseId!, { progress: null, message: null }, t.clock.now);
    expect(view().change).toBe(before);
    heartbeatJob(t.db, r.id, claimed.leaseId!, { progress: 0.5, message: null }, t.clock.now);
    expect(view().change).not.toBe(before);
  });

  test('the change moves with a move and with the pause', () => {
    const a = lease('a');
    lease('b');
    const first = view().change;
    moveJob(t.db, a.id, { to: 'bottom' });
    const second = view().change;
    expect(second).not.toBe(first);
    setQueuePaused(t.db, true, t.clock.now);
    expect(view().change).not.toBe(second);
  });
});

describe('cancelAnyJob', () => {
  test('cancels a job of any owner; a finished one is 409, an unknown one 404', () => {
    const l = lease('x');
    expect(cancelAnyJob(t.db, l.id, t.clock.now).state).toBe('canceled');
    const err = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return e as DomainError;
      }
      throw new Error('expected an error');
    };
    expect(err(() => cancelAnyJob(t.db, l.id, t.clock.now))).toMatchObject({ status: 409 });
    expect(err(() => cancelAnyJob(t.db, 'nope', t.clock.now))).toMatchObject({ status: 404, message: 'job nope not found' });
  });

  test('a running job is canceled at once (the worker learns it at its next heartbeat)', async () => {
    const r = await render('bob');
    claimJob(t.db, t.clock.now);
    expect(cancelAnyJob(t.db, r.id, t.clock.now).state).toBe('canceled');
    expect(t.db.select().from(jobs).where(eq(jobs.id, r.id)).get()?.state).toBe('canceled');
  });
});
