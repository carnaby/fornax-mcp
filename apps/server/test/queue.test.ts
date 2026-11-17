import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { jobs, tokens } from '../src/db/schema.js';
import { cancelJob, getOwnJob, submitJob } from '../src/domain/jobs.js';
import { ABANDONED, abandonRunning, claimJob, confirmJob, ENVIRONMENT_AGAIN, expireLeases, failJob, heartbeatJob, LEASE_MS, releaseJob } from '../src/domain/queue.js';
import { revokeToken } from '../src/domain/tokens.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
let n = 0;

beforeEach(() => {
  n = 0;
  announce(t.db, [renderContract, transcribeContract], t.clock.now);
});

async function job(priority: 'idle' | 'normal' | 'high' = 'normal') {
  const alice = issueToken(t.db, `m${++n}`);
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  return submitJob(t.db, t.config, tokenIdOf(t.db, `m${n}`), { type: 'render', params: { frame_start: 1 }, inputs: { scene }, priority }, t.clock.now);
}
const at = (ms: number) => new Date(t.clock.now.getTime() + ms);

describe('claim', () => {
  test('nothing to do', () => {
    expect(claimJob(t.db, t.clock.now)).toBeNull();
  });

  test('highest priority first, then oldest', async () => {
    const a = await job('normal');
    t.clock.advance(1);
    const b = await job('high');
    t.clock.advance(1);
    const c = await job('normal');
    expect(claimJob(t.db, t.clock.now)?.id).toBe(b.id);
    expect(claimJob(t.db, t.clock.now)?.id).toBe(a.id);
    expect(claimJob(t.db, t.clock.now)?.id).toBe(c.id);
  });

  test('claim sets the lease and counts the attempt', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    expect(c).toMatchObject({ state: 'running', attempts: 1 });
    expect(c.leaseExpiresAt?.getTime()).toBe(t.clock.now.getTime() + LEASE_MS);
  });

  test('a withdrawn type is not claimed; announcing it again makes it claimable', async () => {
    const j = await job();
    announce(t.db, [transcribeContract], t.clock.now);
    expect(claimJob(t.db, t.clock.now)).toBeNull();
    expect(getOwnJob(t.db, j.ownerTokenId, j.id).state).toBe('queued');
    announce(t.db, [renderContract, transcribeContract], t.clock.now);
    expect(claimJob(t.db, t.clock.now)?.id).toBe(j.id);
  });
});

describe('heartbeat', () => {
  test('extends the lease and stores progress', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    const r = heartbeatJob(t.db, c.id, c.leaseId!, { progress: 0.5, message: 'frame 1/2' }, at(30_000));
    expect(r).toEqual({ leaseUntil: at(30_000 + LEASE_MS), cancel: false, requeued: false });
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ progress: 0.5, progressMessage: 'frame 1/2' });
  });

  test('tells the worker when the client canceled', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    cancelJob(t.db, c.ownerTokenId, c.id, t.clock.now);
    expect(heartbeatJob(t.db, c.id, c.leaseId!, { progress: null, message: null }, t.clock.now)).toEqual({ leaseUntil: null, cancel: true, requeued: false });
  });

  test('a wrong lease is 409', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    expect(() => heartbeatJob(t.db, c.id, 'nope', { progress: null, message: null }, t.clock.now)).toThrow(/no longer yours/);
  });
});

describe('lease expiry', () => {
  test('an expired lease puts the job back with the attempt counted', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    expect(expireLeases(t.db, at(LEASE_MS + 1))).toBe(1);
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'queued', attempts: 1 });
  });

  test('a late heartbeat takes the job back if nobody claimed it', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    expireLeases(t.db, at(LEASE_MS + 1));
    heartbeatJob(t.db, c.id, c.leaseId!, { progress: null, message: null }, at(LEASE_MS + 2));
    expect(getOwnJob(t.db, c.ownerTokenId, c.id).state).toBe('running');
  });

  test('a late heartbeat after another claim is 409 and leaves the new holder alone', async () => {
    await job();
    const first = claimJob(t.db, t.clock.now)!;
    const second = claimJob(t.db, at(LEASE_MS + 1))!;
    expect(second.id).toBe(first.id);
    expect(() => heartbeatJob(t.db, first.id, first.leaseId!, { progress: null, message: null }, at(LEASE_MS + 2))).toThrow(/no longer yours/);
    expect(getOwnJob(t.db, second.ownerTokenId, second.id)).toMatchObject({ state: 'running', leaseId: second.leaseId, attempts: 2 });
  });

  test('the last expired attempt fails the job', async () => {
    await job();
    let now = t.clock.now;
    for (let i = 0; i < 3; i++) {
      claimJob(t.db, now);
      now = new Date(now.getTime() + LEASE_MS + 1);
      expireLeases(t.db, now);
    }
    expect(t.db.select().from(jobs).get()).toMatchObject({ state: 'failed', error: expect.stringContaining('lease') });
  });
});

describe('fail and release', () => {
  test('a retried claim starts without the previous error', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    failJob(t.db, c.id, c.leaseId!, { error: 'oom', permanent: false }, t.clock.now);
    expect(getOwnJob(t.db, c.ownerTokenId, c.id).error).toBe('oom');
    claimJob(t.db, at(60_000));
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'running', error: null });
  });

  test('a failed attempt waits 1 min, then 4 min, then fails for good', async () => {
    await job();
    let c = claimJob(t.db, t.clock.now)!;
    expect(failJob(t.db, c.id, c.leaseId!, { error: 'oom', permanent: false }, t.clock.now)).toEqual({ state: 'queued', retryAt: at(60_000) });
    expect(claimJob(t.db, at(59_999))).toBeNull();
    c = claimJob(t.db, at(60_000))!;
    expect(failJob(t.db, c.id, c.leaseId!, { error: 'oom', permanent: false }, at(60_000)).retryAt).toEqual(at(60_000 + 240_000));
    c = claimJob(t.db, at(300_000))!;
    expect(failJob(t.db, c.id, c.leaseId!, { error: 'oom', permanent: false }, at(300_000))).toEqual({ state: 'failed', retryAt: null });
  });

  test('permanent failure fails at once and cleans the error text', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    failJob(t.db, c.id, c.leaseId!, { error: 'bad\ninput\u0000 file', permanent: true }, t.clock.now);
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'failed', error: 'bad input file' });
  });

  test('release gives the attempt back', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    releaseJob(t.db, c.id, c.leaseId!, t.clock.now);
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'queued', attempts: 0, leaseId: null });
  });
});

describe('abandoned claims', () => {
  test('a claim while a job runs requeues it; a job never confirmed gets its attempt back', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    expect(abandonRunning(t.db, at(1000))).toBe(1);
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'queued', attempts: 0, leaseId: null, error: null });
    expect(() => heartbeatJob(t.db, c.id, c.leaseId!, { progress: null, message: null }, at(2000))).toThrow(/no longer yours/);
  });

  test('a confirmed job counts the attempt', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    heartbeatJob(t.db, c.id, c.leaseId!, { progress: 0.1, message: null }, at(1000));
    abandonRunning(t.db, at(2000));
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'queued', attempts: 1, error: ABANDONED, confirmedAt: null });
  });

  test('a confirmed job on its last attempt fails', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    confirmJob(t.db, c.id, at(1000));
    t.db.update(jobs).set({ attempts: 3 }).where(eq(jobs.id, c.id)).run();
    abandonRunning(t.db, at(2000));
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'failed', error: ABANDONED });
  });

  test('an expired lease is handled as before: the attempt counts', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    abandonRunning(t.db, at(LEASE_MS + 1));
    expect(getOwnJob(t.db, c.ownerTokenId, c.id)).toMatchObject({ state: 'queued', attempts: 1 });
  });

  test('nothing running, nothing to do', () => {
    expect(abandonRunning(t.db, t.clock.now)).toBe(0);
  });
});

describe('heartbeat messages and withdrawn types', () => {
  test('an empty message clears the text instead of showing "unknown error"', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    heartbeatJob(t.db, c.id, c.leaseId!, { progress: 0.1, message: 'frame 1' }, at(1000));
    heartbeatJob(t.db, c.id, c.leaseId!, { progress: 0.2, message: '   ' }, at(2000));
    expect(getOwnJob(t.db, c.ownerTokenId, c.id).progressMessage).toBeNull();
  });

  test('a late heartbeat does not revive a job whose type was withdrawn', async () => {
    await job();
    const c = claimJob(t.db, t.clock.now)!;
    expireLeases(t.db, at(LEASE_MS + 1));
    announce(t.db, [transcribeContract], t.clock.now);
    expect(() => heartbeatJob(t.db, c.id, c.leaseId!, { progress: null, message: null }, at(LEASE_MS + 2))).toThrow(/no longer yours/);
    expect(getOwnJob(t.db, c.ownerTokenId, c.id).state).toBe('queued');
  });
});

describe('queue fixes', () => {
  async function queued(owner = 'alice') {
    announce(t.db, [renderContract], t.clock.now);
    const token = issueToken(t.db, owner);
    const scene = await uploadFile(t.app, token, 'scene.blend', 'B');
    const res = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } });
    return { token, id: res.json().id as string };
  }

  test('a second environment release of the same job counts an attempt', async () => {
    const { id } = await queued();
    const first = claimJob(t.db, t.clock.now)!;
    expect(releaseJob(t.db, id, first.leaseId!, t.clock.now, 'environment')).toBe('queued');
    expect(t.db.select().from(jobs).get()).toMatchObject({ state: 'queued', attempts: 0, envReleases: 1 });
    const second = claimJob(t.db, t.clock.now)!;
    expect(releaseJob(t.db, id, second.leaseId!, t.clock.now, 'environment')).toBe('queued');
    const row = t.db.select().from(jobs).get()!;
    expect(row).toMatchObject({ state: 'queued', attempts: 1, error: ENVIRONMENT_AGAIN });
    expect(row.runAfter.getTime()).toBe(t.clock.now.getTime() + 60_000);
  });

  test('a stopping release never counts an attempt, also after an environment release', async () => {
    const { id } = await queued();
    releaseJob(t.db, id, claimJob(t.db, t.clock.now)!.leaseId!, t.clock.now, 'environment');
    releaseJob(t.db, id, claimJob(t.db, t.clock.now)!.leaseId!, t.clock.now, 'stopping');
    expect(t.db.select().from(jobs).get()).toMatchObject({ state: 'queued', attempts: 0, envReleases: 1 });
  });

  test('jobs of a revoked owner are canceled and never claimed', async () => {
    const { id } = await queued('alice');
    const other = await queued('bob');
    revokeToken(t.db, 'alice', t.clock.now);
    expect(t.db.select().from(jobs).all().find((j) => j.id === id)).toMatchObject({ state: 'canceled' });
    expect(claimJob(t.db, t.clock.now)!.id).toBe(other.id);
  });

  test('revoking the owner of a running job cancels it; the worker hears it in the next heartbeat', async () => {
    const { id } = await queued('alice');
    const worker = issueToken(t.db, 'pc', 'worker');
    const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${worker}` }, payload: { wait: 0 } })).json().lease as string;
    revokeToken(t.db, 'alice', t.clock.now);
    const beat = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/heartbeat`, headers: { authorization: `Bearer ${worker}` }, payload: { lease } });
    expect(beat.json()).toMatchObject({ cancel: true });
  });

  test('a queued job whose owner token is no longer active is skipped by the claim', async () => {
    const { id } = await queued('alice');
    // A token made inactive without the cancel path (e.g. by an older server version): the claim still skips its job.
    t.db.update(tokens).set({ status: 'revoked' }).run();
    expect(claimJob(t.db, t.clock.now)).toBeNull();
    expect(t.db.select().from(jobs).get()).toMatchObject({ id, state: 'queued' });
  });
});
