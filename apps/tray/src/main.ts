// The tray window (spec 06 4.2): it shows the snapshots the Rust core sends (event "state") and turns clicks into its
// commands. Its own state is only the drag in progress and an open cancel question.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './style.css';
import type { JobView, LogLine, Snapshot } from './types';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing in index.html`);
  return found as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A local clock time, HH:MM. */
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** m:ss, or h:mm:ss from an hour on; never negative. */
function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

let current: Snapshot | null = null;
/** The job being dragged: while it is, a new snapshot waits (it would replace the rows under the mouse). */
let dragged: string | null = null;
let held: Snapshot | null = null;
/** The job whose cancel asks for a second click. */
let confirming: string | null = null;
/** The server is unreachable or refused the token (spec 06 § 5): the last known queue is grey, its actions inactive. */
let stale = false;

/** The server's clock now: the PC's corrected by the offset the core measured at the last queue line. */
const serverNow = () => Date.now() + (current?.offsetMs ?? 0);

function call(name: string, args?: Record<string, unknown>): void {
  invoke(name, args).catch((e: unknown) => console.error(`${name} failed`, e));
}

function button(text: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = make('button', undefined, text);
  b.type = 'button';
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

const describe = (j: JobView) => [j.type, j.owner, j.what].filter((part) => part !== '').join(' · ');

/** A time that counts up from `fromMs` (server time); tickTimes() refreshes it every second. */
function since(fromMs: number | null): HTMLElement {
  const span = make('span', 'since');
  if (fromMs !== null) {
    span.dataset.from = String(fromMs);
    span.textContent = duration(serverNow() - fromMs);
  }
  return span;
}

function tickTimes(): void {
  for (const span of document.querySelectorAll<HTMLElement>('[data-from]')) {
    span.textContent = duration(serverNow() - Number(span.dataset.from));
  }
}

function rerender(): void {
  if (current) render(current);
}

function cancelControls(j: JobView): HTMLElement[] {
  if (confirming !== j.id) {
    return [button('✕', 'Cancel this job', () => {
      confirming = j.id;
      rerender();
    }, j.pending || stale)];
  }
  const question = make('span', 'confirm', `Cancel the ${j.type} job of ${j.owner}?${j.state === 'running' ? ' It stops within a few seconds.' : ''}`);
  return [
    question,
    button('Yes', 'Cancel the job', () => {
      confirming = null;
      call('cancel_job', { id: j.id });
      rerender();
    }),
    button('No', 'Keep the job', () => {
      confirming = null;
      rerender();
    }),
  ];
}

const actionError = (j: JobView): HTMLElement[] => (j.actionError ? [make('p', 'action-error', j.actionError)] : []);

function renderHeader(s: Snapshot): void {
  el('dot').dataset.icon = s.icon;
  el('headline').textContent = s.headline;
  const server = el('server');
  server.hidden = s.serverDownSinceMs === null && !s.serverRefused;
  if (s.serverRefused) server.textContent = s.serverMessage ?? '';
  else if (s.serverDownSinceMs !== null) server.textContent = `Server unreachable since ${clock(s.serverDownSinceMs)}${s.serverMessage ? ` (${s.serverMessage})` : ''}`;
  else server.textContent = '';
  const note = el('note');
  note.hidden = !s.note;
  note.textContent = s.note ?? '';
  el<HTMLButtonElement>('start').disabled = !s.canStart;
  const stop = el<HTMLButtonElement>('stop');
  stop.disabled = !s.canStop;
  stop.textContent = s.stopLabel;
  const pause = el<HTMLButtonElement>('pause');
  pause.disabled = !s.canPause;
  pause.textContent = s.pauseLabel;
  const pauseError = el('pause-error');
  pauseError.hidden = !s.pauseError;
  pauseError.textContent = s.pauseError ?? '';
  el('quit').hidden = !s.confirmQuit;
}

function renderRunning(s: Snapshot): void {
  const box = el('running');
  const j = s.running;
  if (!j) {
    box.replaceChildren(make('p', 'muted', s.queueKnown ? 'Nothing runs.' : (s.queueNote ?? '')));
    return;
  }
  const head = make('div', 'row');
  head.append(make('span', 'what', describe(j)), since(j.startedAtMs), ...cancelControls(j));
  const bar = make('div', 'bar');
  const fill = make('div');
  fill.style.width = `${Math.round((j.progress ?? 0) * 100)}%`;
  bar.append(fill);
  const meta = [j.progress === null ? '' : `${Math.round(j.progress * 100)} %`, j.progressMessage ?? ''].filter(Boolean).join('  ');
  box.replaceChildren(head, bar, make('p', 'muted', meta), ...actionError(j));
}

/** Whether the mouse is in the lower half of `row` (drop after it). */
const below = (e: DragEvent, row: HTMLElement) => e.clientY - row.getBoundingClientRect().top > row.clientHeight / 2;

function clearMarks(): void {
  for (const r of document.querySelectorAll('.drop-before, .drop-after')) r.classList.remove('drop-before', 'drop-after');
}

function waitingRow(j: JobView, index: number, count: number): HTMLElement {
  const row = make('li', 'job');
  row.draggable = !j.pending && !stale;
  const notes = [j.typeUnavailable ? 'type not offered' : '', j.retryAtMs === null ? '' : `retry at ${clock(j.retryAtMs)}`].filter(Boolean).join(', ');
  const line = make('div', 'row');
  line.append(make('span', 'grip', '⋮⋮'), make('span', 'index', String(index + 1)), make('span', 'what', describe(j)), make('span', 'muted', 'waits'), since(j.createdAtMs));
  if (notes) line.append(make('span', 'notes', notes));
  line.append(
    button('⤒', 'Move to the top', () => call('move_job', { id: j.id, to: 'top', other: null }), j.pending || stale || index === 0),
    button('⤓', 'Move to the bottom', () => call('move_job', { id: j.id, to: 'bottom', other: null }), j.pending || stale || index === count - 1),
    ...cancelControls(j),
  );
  row.append(line, ...actionError(j));
  row.addEventListener('dragstart', (e) => {
    dragged = j.id;
    e.dataTransfer?.setData('text/plain', j.id);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    dragged = null;
    row.classList.remove('dragging');
    clearMarks();
    if (held) {
      const next = held;
      held = null;
      render(next);
    }
  });
  row.addEventListener('dragover', (e) => {
    if (dragged === null || dragged === j.id || stale) return;
    e.preventDefault();
    clearMarks();
    row.classList.add(below(e, row) ? 'drop-after' : 'drop-before');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragged === null || dragged === j.id || stale) return;
    call('move_job', { id: dragged, to: below(e, row) ? 'after' : 'before', other: j.id });
  });
  return row;
}

function renderWaiting(s: Snapshot): void {
  el('waiting-count').textContent = String(s.queued.length);
  const list = el('waiting');
  if (!s.queued.length) {
    list.replaceChildren(make('li', 'muted', s.queueKnown ? 'Nothing waits.' : ''));
    return;
  }
  list.replaceChildren(...s.queued.map((j, i) => waitingRow(j, i, s.queued.length)));
}

const MARKS: Record<string, string> = { succeeded: '✓', failed: '✗', canceled: '–' };

function finishedRow(j: JobView): HTMLElement {
  const row = make('li', `job ${j.state}`);
  const line = make('div', 'row');
  const took = j.startedAtMs !== null && j.finishedAtMs !== null ? duration(j.finishedAtMs - j.startedAtMs) : '';
  line.append(make('span', 'mark', MARKS[j.state] ?? '·'), make('span', 'what', describe(j)));
  if (took) line.append(make('span', 'muted', took));
  if (j.finishedAtMs !== null) line.append(make('span', 'muted', clock(j.finishedAtMs)));
  line.append(button('Result', 'Open the result page', () => call('open_result', { id: j.id })));
  row.append(line);
  if (j.state === 'failed' && j.error) {
    const details = make('details', 'error');
    details.append(make('summary', undefined, 'error'), make('p', undefined, j.error));
    row.append(details);
  }
  return row;
}

function renderFinished(s: Snapshot): void {
  const list = el('finished');
  list.replaceChildren(...(s.finished.length ? s.finished.map(finishedRow) : [make('li', 'muted', s.queueKnown ? 'Nothing finished yet.' : '')]));
}

function renderLog(lines: LogLine[]): void {
  const list = el('log');
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  list.replaceChildren(
    ...lines.map((line) => {
      const item = make('li');
      item.classList.toggle('error', line.error);
      item.append(make('time', undefined, new Date(line.atMs).toLocaleTimeString()), line.text);
      return item;
    }),
  );
  if (atEnd) list.scrollTop = list.scrollHeight;
}

function render(s: Snapshot): void {
  if (dragged !== null) {
    held = s;
    return;
  }
  current = s;
  stale = s.serverDownSinceMs !== null || s.serverRefused;
  el('tray').classList.toggle('stale', stale);
  if (stale || (confirming !== null && ![s.running, ...s.queued].some((j) => j?.id === confirming))) confirming = null;
  renderHeader(s);
  renderRunning(s);
  renderWaiting(s);
  renderFinished(s);
  renderLog(s.log);
}

el('start').addEventListener('click', () => call('start_worker'));
el('stop').addEventListener('click', () => call('stop_worker'));
el('pause').addEventListener('click', () => call('set_paused', { paused: !(current?.paused ?? false) }));
el('quit-yes').addEventListener('click', () => call('confirm_quit', { yes: true }));
el('quit-no').addEventListener('click', () => call('confirm_quit', { yes: false }));
setInterval(tickTimes, 1000);

// The first paint asks for the snapshot; a state event that comes first is newer, and the answer must not undo it.
let painted = false;
void listen<Snapshot>('state', (event) => {
  painted = true;
  render(event.payload);
});
invoke<Snapshot>('snapshot')
  .then((s) => {
    if (!painted) render(s);
  })
  .catch(console.error);
