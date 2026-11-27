// Waiting and Idle (spec 06e § 2.5, spec 07 § 5.1–5.2): the jobs that can start in the order they run, then the idle
// jobs that wait for a person. Drag a row inside its block, or use ⤒ ⤓ (shown on hover or focus); ✕ cancels; the
// HIGH badge, the number or ◷ opens the priority menu; ▶ starts an idle job. While a row is dragged the window holds
// new snapshots (they would replace the rows under the mouse).
import { call } from './bridge';
import { actionError, cancelControls } from './jobs';
import { priorityMenu, priorityTrigger } from './priority';
import { idleJobs, idleNote, turns, waitingJobs, waitingNote, waitingNotes } from './text';
import type { JobView, Snapshot } from './types';
import { button, chip, el, make, timeSpan } from './ui';

type Block = 'waiting' | 'idle';

let dragged: { id: string; block: Block } | null = null;
let afterDrag: () => void = () => {};

export const isDragging = (): boolean => dragged !== null;
/** What runs when a drag ends (main.ts draws the snapshot it held). */
export function onDragEnd(hook: () => void): void {
  afterDrag = hook;
}

/** Whether the mouse is in the lower half of `row` (drop after it). */
const below = (e: DragEvent, row: HTMLElement) => e.clientY - row.getBoundingClientRect().top > row.clientHeight / 2;

function clearMarks(): void {
  for (const r of document.querySelectorAll('.drop-before, .drop-after')) r.classList.remove('drop-before', 'drop-after');
}

type RowContext = { block: Block; jobs: JobView[]; turns: string[]; stale: boolean; can: boolean };

function row(j: JobView, index: number, c: RowContext): HTMLElement {
  const { block, jobs, stale, can } = c;
  const li = make('li', 'wrow');
  li.draggable = !j.pending && !stale;
  const name = make('span', 'file', j.what || j.id);
  name.title = j.what || j.id;
  const line = make('div', 'run-line');
  line.append(chip(j.type), name);
  const pieces: (string | HTMLElement)[] = [`from ${j.owner}`];
  if (block === 'idle') pieces.push(` · ${idleNote(j)}`);
  else if (j.createdAtMs !== null) pieces.push(' · queued ', timeSpan(j.createdAtMs, 'ago'));
  for (const note of waitingNotes(j)) pieces.push(' · ', make('span', note.bad ? 'bad' : '', note.text));
  const sub = make('div', 'wsub');
  sub.append(...pieces);
  const main = make('div', 'wmain');
  main.append(line, sub, ...actionError(j));
  const high = block === 'waiting' && j.priority === 'high';
  const trigger = priorityTrigger(j, block === 'idle' ? '◷' : high ? 'HIGH' : c.turns[index]!, high ? 'prio prio-high' : 'wpos', { stale, can });
  // ⤒ ⤓ move inside the block: before its first row, after its last.
  const first = jobs[0]!.id;
  const last = jobs[jobs.length - 1]!.id;
  li.append(
    trigger,
    main,
    button(`${j.id} top`, '⤒', 'Move to the top', () => call('move_job', { id: j.id, to: 'before', other: first }), {
      disabled: j.pending || stale || index === 0,
      className: 'icon move',
    }),
    button(`${j.id} bottom`, '⤓', 'Move to the bottom', () => call('move_job', { id: j.id, to: 'after', other: last }), {
      disabled: j.pending || stale || index === jobs.length - 1,
      className: 'icon move',
    }),
    ...(block === 'idle' && can
      ? [button(`${j.id} start`, '▶', 'Start', () => call('set_priority', { id: j.id, priority: 'normal' }), { disabled: j.pending || stale, className: 'icon start' })]
      : []),
    ...cancelControls(j, { stale, label: '✕', className: 'icon', title: 'Remove from the queue', question: `Cancel the ${j.type} job of ${j.owner}?` }),
    ...priorityMenu(j),
  );
  li.addEventListener('dragstart', (e) => {
    dragged = { id: j.id, block };
    e.dataTransfer?.setData('text/plain', j.id);
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    dragged = null;
    li.classList.remove('dragging');
    clearMarks();
    afterDrag();
  });
  // A row is dropped only inside its own block (spec 07 § 5.1).
  const droppable = () => dragged !== null && dragged.id !== j.id && dragged.block === block && !stale;
  li.addEventListener('dragover', (e) => {
    if (!droppable()) return;
    e.preventDefault();
    clearMarks();
    li.classList.add(below(e, li) ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!droppable()) return;
    call('move_job', { id: dragged!.id, to: below(e, li) ? 'after' : 'before', other: j.id });
  });
  return li;
}

function renderIdle(s: Snapshot, stale: boolean): void {
  const jobs = idleJobs(s);
  el('idle-block').hidden = jobs.length === 0;
  el('idle-title').textContent = `Idle · ${jobs.length}`;
  const start = el<HTMLButtonElement>('start-idle');
  start.hidden = !s.canPrioritize;
  start.disabled = s.startIdlePending || stale;
  start.onclick = () => call('start_idle');
  const error = el('start-idle-error');
  error.hidden = s.startIdleError === null;
  error.textContent = s.startIdleError ?? '';
  const c: RowContext = { block: 'idle', jobs, turns: [], stale, can: s.canPrioritize };
  el('idle').replaceChildren(...jobs.map((j, i) => row(j, i, c)));
}

export function renderWaiting(s: Snapshot, stale: boolean): void {
  const jobs = waitingJobs(s);
  el('waiting-title').textContent = s.queueKnown ? `Waiting · ${jobs.length}` : 'Waiting';
  const note = waitingNote(s);
  const noteEl = el('waiting-note');
  noteEl.textContent = note.text;
  noteEl.classList.toggle('lease', note.lease);
  const list = el('waiting');
  if (!jobs.length) list.replaceChildren(make('li', 'wempty', s.queueKnown ? 'Nothing waits.' : (s.queueNote ?? '')));
  else {
    const c: RowContext = { block: 'waiting', jobs, turns: turns(jobs), stale, can: s.canPrioritize };
    list.replaceChildren(...jobs.map((j, i) => row(j, i, c)));
  }
  renderIdle(s, stale);
}
