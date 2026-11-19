// The window's texts and numbers (spec 06e § 2): pure functions, tested in text.test.ts.
import type { CardWait, JobView, Snapshot } from './types';

const MIN = 60_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** m:ss, or h:mm:ss from an hour on; never negative. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** A local clock time, HH:MM. */
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "3h 12m" since the worker started. */
export function uptime(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** "4 min ago" since a job was queued. */
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
}

/** Spec 06e § 2.4: the time left from the elapsed time and the progress, from 5 % on. */
export function etaMs(elapsedMs: number, progress: number | null): number | null {
  if (progress === null || progress < 0.05 || progress >= 1 || elapsedMs <= 0) return null;
  return (elapsedMs * (1 - progress)) / progress;
}

/** MiB as GB with one decimal. */
export const gb = (mib: number): string => (mib / 1024).toFixed(1);
/** MiB as GB in a sentence: two decimals below 1 GB, one above, no trailing zeros. */
export const gbShort = (mib: number): string => String(Number((mib / 1024).toFixed(mib < 1024 ? 2 : 1)));

/** The left side under a progress bar: the job's message and the percent (the message alone when it has a percent). */
export function progressText(message: string | null, progress: number | null): string {
  const percent = progress === null ? '' : `${Math.round(progress * 100)} %`;
  if (message && percent) return message.includes('%') ? message : `${message} · ${percent}`;
  return message || percent;
}

const KNOWN_TYPES: readonly string[] = ['lease', 'render', 'transcribe', 'upscale'];
/** Spec 06e § 2.1: the four known types have colours; any other gets a neutral chip. */
export const chipClass = (type: string): string => (KNOWN_TYPES.includes(type) ? `chip chip-${type}` : 'chip');

/** Spec 06e § 2.3: why the next job waits for the card (only for `gpu_busy`). */
export function cardBusySentence(w: CardWait): string | null {
  if (w.reason !== 'gpu_busy' || w.usedMib === null || w.limitMib === null) return null;
  return `Other programs use ${gbShort(w.usedMib)} GB; the next job starts when they use at most ${gbShort(w.limitMib)} GB. Rechecking every 10 s.`;
}

/** Spec 06e § 2.3: who holds the card, for the GPU strip. */
export function holderText(s: Snapshot): string {
  switch (s.gpuHolder.kind) {
    case 'lease':
      return `lease: ${s.gpuHolder.owner ?? '?'}`;
    case 'fornax':
      return 'Fornax';
    case 'outside':
      return 'outside Fornax';
    default:
      return 'idle';
  }
}

/** Spec 06e § 2.4: the empty Running card, first match wins. */
/** Spec 07 § 5.1–5.2: Waiting shows the jobs that can start; Idle the ones that wait for a person. */
export const isIdle = (j: JobView): boolean => j.priority === 'idle';
export const waitingJobs = (s: Snapshot): JobView[] => s.queued.filter((j) => !isIdle(j));
export const idleJobs = (s: Snapshot): JobView[] => s.queued.filter(isIdle);

export const idleNote = (j: JobView): string => (j.idleSinceMs === null ? 'idle' : `idle since ${clock(j.idleSinceMs)}`);
export const requeueQuestion = (j: JobView): string => `Put the ${j.type} job of ${j.owner} back in the queue? It starts again from the beginning.`;
export const pauseQuestion = (j: JobView): string =>
  `Pause the ${j.type} job of ${j.owner}? It goes to Idle and starts again from the beginning when you start it.`;

export function nothingRuns(s: Snapshot): string {
  if (!s.queueKnown) return s.queueNote ?? '';
  const n = waitingJobs(s).length;
  const jobs = n === 1 ? '1 job waits' : `${n} jobs wait`;
  if (s.cardWait !== null && n > 0) return `Nothing runs: ${jobs} for the GPU.`;
  if (s.paused) return 'Nothing runs: the queue is paused.';
  if (s.canStart && n > 0) return 'Nothing runs: the worker is stopped.';
  const idle = idleJobs(s).length;
  if (idle === 1) return 'Nothing runs. 1 idle job waits for you to start it.';
  if (idle > 1) return `Nothing runs. ${idle} idle jobs wait for you to start them.`;
  return 'Nothing runs.';
}

/** Spec 06e § 2.5: the note right of "Waiting". */
export function waitingNote(s: Snapshot): { text: string; lease: boolean } {
  if (s.running?.type === 'lease') return { text: 'held until the lease ends', lease: true };
  if (s.paused) return { text: 'paused', lease: false };
  return { text: 'in the order they run', lease: false };
}

/** Spec 06e § 2.5: the notes of a waiting job. */
export function waitingNotes(j: JobView): { text: string; bad: boolean }[] {
  const notes: { text: string; bad: boolean }[] = [];
  if (j.typeUnavailable) notes.push({ text: 'type not offered', bad: true });
  if (j.retryAtMs !== null) notes.push({ text: `retry at ${clock(j.retryAtMs)}`, bad: false });
  return notes;
}

/** Spec 06e § 2.6: the line under a finished job. */
/** Local midnight of the day `ms` falls on. */
function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The local day `ms` falls on, as a key that changes at midnight. */
export const dayKey = (ms: number): string => new Date(dayStart(ms)).toDateString();

/**
 * The History tab's two days: the jobs that finished today (local midnight on; a job ahead of the clock or without a
 * finish time counts as today) and yesterday, each in the snapshot's order. Older days are not shown.
 */
export function historyDays(finished: JobView[], nowMs: number): { today: JobView[]; yesterday: JobView[] } {
  const todayStart = dayStart(nowMs);
  const y = new Date(todayStart);
  y.setDate(y.getDate() - 1);
  const yesterdayStart = y.getTime();
  const today: JobView[] = [];
  const yesterday: JobView[] = [];
  for (const j of finished) {
    if (j.finishedAtMs === null || j.finishedAtMs >= todayStart) today.push(j);
    else if (j.finishedAtMs >= yesterdayStart) yesterday.push(j);
  }
  return { today, yesterday };
}

export function historySub(j: JobView): string {
  const parts = [j.owner];
  if (j.finishedAtMs !== null) parts.push(clock(j.finishedAtMs));
  if (j.startedAtMs !== null && j.finishedAtMs !== null) {
    parts.push(`${j.type === 'lease' ? 'held' : 'took'} ${duration(j.finishedAtMs - j.startedAtMs)}`);
  }
  return parts.join(' · ');
}
