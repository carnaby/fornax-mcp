// What the Rust core sends (state.rs: Snapshot, JobView, LogLine, GpuView …; serde renames the fields to camelCase). A
// test in state.rs (the_snapshot_keeps_the_names_types_ts_reads) pins the names.
export type Icon = 'stopped' | 'attention' | 'idle' | 'busy' | 'paused' | 'card' | 'lease' | 'error';

export type LogLine = { atMs: number; text: string; error: boolean };

export type JobView = {
  id: string;
  type: string;
  owner: string;
  what: string;
  state: string;
  priority: string;
  typeUnavailable: boolean;
  retryAtMs: number | null;
  /** Spec 07 § 5.2: since when the job is idle. */
  idleSinceMs: number | null;
  createdAtMs: number | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  progress: number | null;
  progressMessage: string | null;
  error: string | null;
  resultUrl: string;
  pending: boolean;
  actionError: string | null;
};

/** One job type of the worker (spec 06c 4.3). */
export type TypeView = { name: string; state: 'offered' | 'waiting' | 'unavailable'; reason: string | null };

/** Spec 06e § 2.2. */
export type Tone = 'ok' | 'ok-dim' | 'lease' | 'warn' | 'error' | 'off';
export type StatusView = { label: string; tone: Tone };

/** Spec 06e § 2.3: the tray's own reading of the card. */
export type GpuView = {
  state: 'reading' | 'ok' | 'missing' | 'failed';
  name: string | null;
  usedMib: number | null;
  totalMib: number | null;
  utilization: number | null;
  temperature: number | null;
  problem: string | null;
};
export type GpuHolder = { kind: 'lease' | 'fornax' | 'outside' | 'idle'; owner: string | null };
/** The worker's reason to take no job (`gpu_busy` or `gpu_unreadable`). */
export type CardWait = { reason: string; usedMib: number | null; totalMib: number | null; limitMib: number | null; error: string | null };

export type Snapshot = {
  icon: Icon;
  tooltip: string;
  headline: string;
  note: string | null;
  canStart: boolean;
  canStop: boolean;
  stopLabel: string;
  canPause: boolean;
  /** Spec 07 § 5.4: the priority menu, Start all, Requeue and Pause are offered (fornax 0.9.0 or newer). */
  canPrioritize: boolean;
  startIdlePending: boolean;
  startIdleError: string | null;
  paused: boolean;
  pauseLabel: string;
  pauseError: string | null;
  startWorker: boolean;
  confirmQuit: boolean;
  queueKnown: boolean;
  queueNote: string | null;
  serverDownSinceMs: number | null;
  serverMessage: string | null;
  /** The last failure was a refused worker token: serverMessage says so on its own line (spec 06 § 5). */
  serverRefused: boolean;
  offsetMs: number;
  running: JobView | null;
  queued: JobView[];
  finished: JobView[];
  log: LogLine[];
  types: TypeView[];
  /** Why there is no list of types (worker stopped, outside the tray, checking, old CLI); null when there is one. */
  typesNote: string | null;
  /** Spec 06d 4.1: "tray 0.7.0 · fornax 0.7.0 · server 0.7.1". */
  versions: string;
  /** "Update to 0.7.1" / "Update fornax to 0.7.1" when one is offered. */
  updateLabel: string | null;
  canUpdate: boolean;
  canCancelUpdate: boolean;
  /** An update runs, in any phase. */
  updating: boolean;
  /** Why the last update failed, or the AppImage's note. */
  updateNote: string | null;
  gpu: GpuView;
  status: StatusView;
  /** "Worker running", "Worker stopped", … */
  workerText: string;
  /** "queue active", "queue paused", "pausing after the running job"; null while the queue is unknown. */
  queueText: string | null;
  /** PC time the tray's worker started, while it runs. */
  workerSinceMs: number | null;
  gpuHolder: GpuHolder;
  cardWait: CardWait | null;
};
