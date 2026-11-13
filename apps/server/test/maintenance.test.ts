import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateToken } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { files, jobs, tokens } from '../src/db/schema.js';
import { runMaintenance, TYPE_UNAVAILABLE } from '../src/domain/maintenance.js';
import { claimJob } from '../src/domain/queue.js';
import { createInvite, resolveToken } from '../src/domain/tokens.js';
import { FileStore } from '../src/files/store.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const deps = () => ({ config: t.config, db: t.db, store: new FileStore(t.config.filesDir), clock: () => t.clock.now });
const submit = async (token: string, file: string) =>
  (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene: file } } })).json().id as string;

describe('maintenance', () => {
  test('orphan uploads go after 24 h; inputs of jobs stay', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const orphan = await uploadFile(t.app, alice, 'a.blend', 'A');
    const used = await uploadFile(t.app, alice, 'b.blend', 'B');
    await submit(alice, used);
    t.clock.advance(24 * HOUR - 1);
    expect((await runMaintenance(deps())).orphans).toBe(0);
    t.clock.advance(2);
    expect((await runMaintenance(deps())).orphans).toBe(1);
    expect(existsSync(join(t.config.filesDir, orphan))).toBe(false);
    expect(existsSync(join(t.config.filesDir, used))).toBe(true);
  });

  test('finished jobs and their files go after the retention', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const file = await uploadFile(t.app, alice, 'a.blend', 'A');
    const id = await submit(alice, file);
    await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: { authorization: `Bearer ${alice}` } });
    t.clock.advance(14 * DAY + 1);
    expect((await runMaintenance(deps())).finished).toBe(1);
    expect(t.db.select().from(jobs).all()).toEqual([]);
    expect(t.db.select().from(files).all()).toEqual([]);
    expect(existsSync(join(t.config.filesDir, file))).toBe(false);
  });

  test('queued jobs of a type withdrawn for 7 days fail', async () => {
    announce(t.db, [renderContract, transcribeContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const id = await submit(alice, await uploadFile(t.app, alice, 'a.blend', 'A'));
    announce(t.db, [transcribeContract], t.clock.now);
    t.clock.advance(7 * DAY - 1);
    expect((await runMaintenance(deps())).unavailable).toBe(0);
    t.clock.advance(2);
    expect((await runMaintenance(deps())).unavailable).toBe(1);
    expect(t.db.select().from(jobs).get()).toMatchObject({ id, state: 'failed', error: TYPE_UNAVAILABLE });
  });

  test('a type still offered is never failed, however old the job', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    await submit(alice, await uploadFile(t.app, alice, 'a.blend', 'A'));
    t.clock.advance(30 * DAY);
    expect((await runMaintenance(deps())).unavailable).toBe(0);
  });

  test('pending tokens go after 7 days; expired leases are released', async () => {
    createInvite(t.db, { name: 'alice', role: 'client' }, t.clock.now);
    resolveToken(t.db, generateToken('alice'), t.clock.now);
    announce(t.db, [renderContract], t.clock.now);
    const eve = issueToken(t.db, 'eve');
    await submit(eve, await uploadFile(t.app, eve, 'a.blend', 'A'));
    claimJob(t.db, t.clock.now);
    t.clock.advance(7 * DAY + 1);
    // The 7-day-old render type is still offered (announce above), so only the lease and the token change.
    const r = await runMaintenance(deps());
    expect(r).toMatchObject({ pendingTokens: 1, leases: 1 });
    expect(t.db.select().from(tokens).all().map((x) => x.name)).toEqual(['eve']);
  });
});
