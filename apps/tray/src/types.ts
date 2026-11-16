// What the Rust core sends (state.rs: Snapshot, JobView, LogLine; serde renames the fields to camelCase). A test in
// state.rs (the_snapshot_keeps_the_names_types_ts_reads) pins the names.
export type Icon = 'stopped' | 'attention' | 'idle' | 'busy' | 'paused' | 'card' | 'error';

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

export type Snapshot = {
  icon: Icon;
  tooltip: string;
  headline: string;
  note: string | null;
  canStart: boolean;
  canStop: boolean;
  stopLabel: string;
  canPause: boolean;
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
  /** Why the last update failed, or the AppImage's note. */
  updateNote: string | null;
};
