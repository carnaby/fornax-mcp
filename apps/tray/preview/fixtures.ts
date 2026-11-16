// Made-up snapshots for the preview and the window's tests (spec 06e § 4). Public repository: only alice, bob, carol
// and fornax.example.com.
import type { JobView, Snapshot } from '../src/types';

const MIN = 60_000;

export function job(over: Partial<JobView> & { id: string }): JobView {
  return {
    type: 'upscale',
    owner: 'alice',
    what: 'clip.mp4',
    state: 'queued',
    priority: 'normal',
    typeUnavailable: false,
    retryAtMs: null,
    createdAtMs: Date.now() - 4 * MIN,
    startedAtMs: null,
    finishedAtMs: null,
    progress: null,
    progressMessage: null,
    error: null,
    resultUrl: `https://fornax.example.com/r/${over.id}`,
    pending: false,
    actionError: null,
    ...over,
  };
}

/** The main artboard: an upscale job runs, three wait, four finished. */
export function base(): Snapshot {
  const t = Date.now();
  return {
    icon: 'busy',
    tooltip: 'Fornax: Worker running · queue active',
    headline: 'Worker running · queue active',
    note: null,
    canStart: false,
    canStop: true,
    stopLabel: 'Stop worker',
    canPause: true,
    paused: false,
    pauseLabel: 'Pause queue',
    pauseError: null,
    startWorker: true,
    confirmQuit: false,
    queueKnown: true,
    queueNote: null,
    serverDownSinceMs: null,
    serverMessage: null,
    serverRefused: false,
    offsetMs: 0,
    running: job({ id: 'R1', owner: 'alice', what: 'clip_0412.mp4', state: 'running', startedAtMs: t - 113_000, progress: 0.65, progressMessage: 'frame 412 / 636' }),
    queued: [
      job({ id: 'Q1', type: 'transcribe', owner: 'bob', what: 'interview.mp3', createdAtMs: t - 4 * MIN }),
      job({ id: 'Q2', type: 'render', owner: 'carol', what: 'test_render_v2.blend', createdAtMs: t - 2 * MIN, priority: 'high' }),
      job({ id: 'Q3', owner: 'alice', what: 'a_very_long_file_name_of_a_clip_from_the_holiday_in_the_mountains_2026_final_v3.mp4', createdAtMs: t - 20_000 }),
    ],
    finished: [
      job({ id: 'F1', owner: 'alice', what: 'clip_0398.mp4', state: 'succeeded', startedAtMs: t - 30 * MIN, finishedAtMs: t - 28 * MIN }),
      job({
        id: 'F2',
        type: 'transcribe',
        owner: 'bob',
        what: 'podcast_ep4.wav',
        state: 'failed',
        startedAtMs: t - 50 * MIN,
        finishedAtMs: t - 49 * MIN,
        error: 'CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 15.93 GiB total capacity; 13.10 GiB already allocated)\nthe job ran out of video memory: free the card or lower the batch size',
      }),
      job({ id: 'F3', type: 'lease', owner: 'bob', what: 'scene_04_cycles', state: 'succeeded', startedAtMs: t - 120 * MIN, finishedAtMs: t - 82 * MIN }),
      job({ id: 'F4', type: 'render', owner: 'carol', what: 'old_scene.blend', state: 'canceled', finishedAtMs: t - 130 * MIN }),
    ],
    log: [
      { atMs: t - 200_000, text: 'worker 0.8.0 started', error: false },
      { atMs: t - 190_000, text: 'offering: lease, render, transcribe, upscale', error: false },
      { atMs: t - 115_000, text: 'job R1: upscale, attempt 1', error: false },
      { atMs: t - 30_000, text: 'job F2: failed', error: true },
    ],
    types: [
      { name: 'lease', state: 'offered', reason: null },
      { name: 'render', state: 'offered', reason: null },
      { name: 'transcribe', state: 'offered', reason: null },
      { name: 'upscale', state: 'offered', reason: null },
    ],
    typesNote: null,
    versions: 'tray 0.8.0 · fornax 0.8.0 · server 0.8.0',
    updateLabel: null,
    canUpdate: false,
    canCancelUpdate: false,
    updating: false,
    updateNote: null,
    gpu: { state: 'ok', name: 'NVIDIA GeForce RTX 5060 Ti', usedMib: 10_900, totalMib: 16_311, utilization: 94, temperature: 71, problem: null },
    status: { label: 'Running', tone: 'ok' },
    workerText: 'Worker running',
    queueText: 'queue active',
    workerSinceMs: t - (3 * 60 + 12) * MIN,
    gpuHolder: { kind: 'fornax', owner: null },
    cardWait: null,
  };
}

const lease = (): Snapshot => {
  const s = base();
  const t = Date.now();
  return {
    ...s,
    icon: 'lease',
    running: job({ id: 'L1', type: 'lease', owner: 'bob', what: 'scene_05_cycles', state: 'running', startedAtMs: t - 12 * MIN - 40_000 }),
    status: { label: 'Leased', tone: 'lease' },
    gpuHolder: { kind: 'lease', owner: 'bob' },
    gpu: { ...s.gpu, usedMib: 9_900, utilization: 88, temperature: 74 },
  };
};

const blocked = (): Snapshot => {
  const s = base();
  return {
    ...s,
    icon: 'card',
    running: null,
    queued: s.queued.slice(0, 1),
    status: { label: 'Waiting for GPU', tone: 'error' },
    gpuHolder: { kind: 'outside', owner: null },
    gpu: { ...s.gpu, usedMib: 8_600, utilization: 97, temperature: 78 },
    cardWait: { reason: 'gpu_busy', usedMib: 8_396, totalMib: 16_311, limitMib: 768, error: null },
  };
};

const nocard = (): Snapshot => {
  const s = base();
  return {
    ...s,
    icon: 'card',
    running: null,
    status: { label: 'No card', tone: 'error' },
    gpuHolder: { kind: 'idle', owner: null },
    gpu: { state: 'failed', name: null, usedMib: null, totalMib: null, utilization: null, temperature: null, problem: 'No devices were found' },
    cardWait: { reason: 'gpu_unreadable', usedMib: null, totalMib: null, limitMib: 768, error: 'No devices were found' },
    types: s.types.map((t) => (t.name === 'lease' ? t : { ...t, state: 'waiting' as const, reason: 'waiting for the card' })),
  };
};

const stopped = (): Snapshot => {
  const s = base();
  return {
    ...s,
    icon: 'attention',
    canStart: true,
    canStop: false,
    running: null,
    status: { label: 'Stopped', tone: 'off' },
    workerText: 'Worker stopped',
    workerSinceMs: null,
    gpuHolder: { kind: 'idle', owner: null },
    gpu: { ...s.gpu, usedMib: 412, utilization: 0, temperature: 38 },
    types: [],
    typesNote: 'The worker is stopped.',
  };
};

const nonvidia = (): Snapshot => ({
  ...stopped(),
  gpu: { state: 'missing', name: null, usedMib: null, totalMib: null, utilization: null, temperature: null, problem: null },
});

const serverDown = (): Snapshot => ({
  ...base(),
  serverDownSinceMs: Date.now() - 5 * MIN,
  serverMessage: 'cannot reach the server: ECONNREFUSED',
});

const update = (): Snapshot => ({
  ...base(),
  updateLabel: 'Update to 0.8.1',
  canUpdate: true,
  versions: 'tray 0.8.0 · fornax 0.8.0 · server 0.8.1',
});

const quit = (): Snapshot => ({ ...base(), confirmQuit: true });

const empty = (): Snapshot => ({
  ...base(),
  icon: 'idle',
  running: null,
  queued: [],
  finished: [],
  status: { label: 'Idle', tone: 'ok-dim' },
  gpuHolder: { kind: 'idle', owner: null },
  gpu: { ...base().gpu, usedMib: 412, utilization: 0, temperature: 38 },
});

/** Review Focus 2: everything at once in a short window. */
const crowded = (): Snapshot => {
  const s = update();
  const t = Date.now();
  return {
    ...s,
    note: 'the worker ended: another fornax worker runs on this PC (pid 4242); stop it first',
    pauseError: 'the server answered 502',
    queued: Array.from({ length: 8 }, (_, i) => job({ id: `Q${i + 1}`, owner: ['alice', 'bob', 'carol'][i % 3]!, what: `clip_${i + 1}.mp4`, createdAtMs: t - (8 - i) * MIN })),
    types: [...s.types, { name: 'echo', state: 'unavailable', reason: 'its check failed: python was not found; set tools.python in worker.yaml' }],
  };
};

export const FIXTURES = {
  main: base,
  lease,
  blocked,
  nocard,
  nonvidia,
  stopped,
  'server-down': serverDown,
  update,
  quit,
  empty,
  crowded,
} satisfies Record<string, () => Snapshot>;
