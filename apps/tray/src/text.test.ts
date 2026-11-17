import { describe, expect, test } from 'vitest';
import { base, FIXTURES, job } from '../preview/fixtures';
import {
  ago, cardBusySentence, chipClass, clock, duration, etaMs, gb, gbShort, historySub, holderText, idleJobs, idleNote, nothingRuns,
  pauseQuestion, progressText, requeueQuestion, uptime, waitingJobs, waitingNote, waitingNotes,
} from './text';

const MIN = 60_000;

describe('times', () => {
  test('duration: m:ss, from an hour on h:mm:ss, never negative', () => {
    expect([duration(0), duration(61_000), duration(3_725_000), duration(-5)]).toEqual(['0:00', '1:01', '1:02:05', '0:00']);
  });
  test('uptime: under a minute, minutes, hours and minutes, days and hours', () => {
    expect([uptime(30_000), uptime(12 * MIN), uptime(192 * MIN), uptime((2 * 24 * 60 + 3 * 60 + 5) * MIN)]).toEqual([
      'under a minute', '12m', '3h 12m', '2d 3h',
    ]);
  });
  test('ago: just now, minutes, hours', () => {
    expect([ago(20_000), ago(4 * MIN), ago(60 * MIN), ago(65 * MIN)]).toEqual(['just now', '4 min ago', '1 h ago', '1 h 5 min ago']);
  });
  test('the time left: only from 5 % on and below 100 %', () => {
    expect(etaMs(113_000, 0.65)).toBeCloseTo((113_000 * 0.35) / 0.65);
    expect([etaMs(10_000, 0.04), etaMs(10_000, 1), etaMs(10_000, null), etaMs(0, 0.5)]).toEqual([null, null, null, null]);
  });
});

describe('numbers and words', () => {
  test('GB with one decimal; the short form drops trailing zeros and keeps two decimals below 1 GB', () => {
    expect([gb(16_311), gb(6_400), gbShort(768), gbShort(8_396), gbShort(1_024)]).toEqual(['15.9', '6.3', '0.75', '8.2', '1']);
  });
  test('progress: message and percent, the message alone when it has its own percent', () => {
    expect([
      progressText('frame 412 / 636', 0.65),
      progressText('42 % of the frames', 0.42),
      progressText(null, 0.5),
      progressText('loading the model', null),
      progressText(null, null),
    ]).toEqual(['frame 412 / 636 · 65 %', '42 % of the frames', '50 %', 'loading the model', '']);
  });
  test('the four known types have their colours, any other a neutral chip', () => {
    expect([chipClass('upscale'), chipClass('lease'), chipClass('echo')]).toEqual(['chip chip-upscale', 'chip chip-lease', 'chip']);
  });
  test('the sentence of a busy card', () => {
    expect(cardBusySentence({ reason: 'gpu_busy', usedMib: 8_396, totalMib: 16_311, limitMib: 768, error: null })).toBe(
      'Other programs use 8.2 GB; the next job starts when they use at most 0.75 GB. Rechecking every 10 s.',
    );
    expect(cardBusySentence({ reason: 'gpu_unreadable', usedMib: null, totalMib: null, limitMib: 768, error: 'x' })).toBeNull();
  });
  test('who holds the card', () => {
    expect([holderText(FIXTURES.main()), holderText(FIXTURES.lease()), holderText(FIXTURES.blocked()), holderText(FIXTURES.empty())]).toEqual([
      'Fornax', 'lease: bob', 'outside Fornax', 'idle',
    ]);
  });
});

describe('sentences of the sections', () => {
  test('why nothing runs (spec 06e § 2.4, first match wins)', () => {
    const s = base();
    expect(nothingRuns({ ...s, queueKnown: false, queueNote: 'Reading the queue…' })).toBe('Reading the queue…');
    expect(nothingRuns(FIXTURES.blocked())).toBe('Nothing runs: 1 job waits for the GPU.');
    expect(nothingRuns({ ...s, running: null, paused: true })).toBe('Nothing runs: the queue is paused.');
    expect(nothingRuns(FIXTURES.stopped())).toBe('Nothing runs: the worker is stopped.');
    expect(nothingRuns(FIXTURES.empty())).toBe('Nothing runs.');
  });
  test('the note next to Waiting', () => {
    expect(waitingNote(FIXTURES.lease())).toEqual({ text: 'held until the lease ends', lease: true });
    expect(waitingNote({ ...base(), paused: true })).toEqual({ text: 'paused', lease: false });
    expect(waitingNote(base())).toEqual({ text: 'in the order they run', lease: false });
  });
  test('the notes of a waiting job', () => {
    const retry = Date.now() + 5 * MIN;
    // Spec 07 § 5.1: the HIGH badge and the Idle block show the priority; the notes no longer repeat it.
    expect(waitingNotes(job({ id: 'Q', typeUnavailable: true, retryAtMs: retry, priority: 'high' }))).toEqual([
      { text: 'type not offered', bad: true },
      { text: `retry at ${clock(retry)}`, bad: false },
    ]);
    expect(waitingNotes(job({ id: 'Q' }))).toEqual([]);
  });
  test('the line under a finished job: took, held for a lease, no times for a job that never ran', () => {
    const t = Date.now();
    expect(historySub(job({ id: 'F', state: 'succeeded', startedAtMs: t - 97_000, finishedAtMs: t }))).toBe(`alice · ${clock(t)} · took 1:37`);
    expect(historySub(job({ id: 'F', type: 'lease', owner: 'bob', state: 'succeeded', startedAtMs: t - 60_000, finishedAtMs: t }))).toBe(
      `bob · ${clock(t)} · held 1:00`,
    );
    expect(historySub(job({ id: 'F', state: 'canceled', finishedAtMs: t }))).toBe(`alice · ${clock(t)}`);
  });
});

describe('spec 07 texts', () => {
  test('waiting and idle split the queued jobs', () => {
    const s = { ...base(), queued: [job({ id: 'A', priority: 'high' }), job({ id: 'B', priority: 'idle' }), job({ id: 'C' })] };
    expect(waitingJobs(s).map((j) => j.id)).toEqual(['A', 'C']);
    expect(idleJobs(s).map((j) => j.id)).toEqual(['B']);
  });

  test('nothing runs and only idle jobs wait', () => {
    const one = { ...base(), running: null, queued: [job({ id: 'B', priority: 'idle' })] };
    expect(nothingRuns(one)).toBe('Nothing runs. 1 idle job waits for you to start it.');
    const three = { ...one, queued: ['B', 'C', 'D'].map((id) => job({ id, priority: 'idle' })) };
    expect(nothingRuns(three)).toBe('Nothing runs. 3 idle jobs wait for you to start them.');
  });

  test('a paused queue or a stopped worker still says so; idle jobs do not count as waiting', () => {
    const s = { ...base(), running: null, paused: true, queued: [job({ id: 'B', priority: 'idle' }), job({ id: 'C' })] };
    expect(nothingRuns(s)).toBe('Nothing runs: the queue is paused.');
    const stopped = { ...FIXTURES.stopped(), queued: [job({ id: 'B', priority: 'idle' })] };
    expect(nothingRuns(stopped)).toBe('Nothing runs. 1 idle job waits for you to start it.');
  });

  test('idle since and the two questions', () => {
    const at = new Date(2026, 10, 17, 16, 9).getTime();
    expect(idleNote(job({ id: 'B', priority: 'idle', idleSinceMs: at }))).toBe('idle since 16:09');
    expect(idleNote(job({ id: 'B', priority: 'idle', idleSinceMs: null }))).toBe('idle');
    const r = job({ id: 'R', type: 'upscale', owner: 'bob', state: 'running' });
    expect(requeueQuestion(r)).toBe('Put the upscale job of bob back in the queue? It starts again from the beginning.');
    expect(pauseQuestion(r)).toBe('Pause the upscale job of bob? It goes to Idle and starts again from the beginning when you start it.');
  });
});
