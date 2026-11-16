// Waiting (spec 06e § 2.5): the jobs in the order they run. Drag a row, or use ⤒ ⤓ (shown on hover or focus); ✕
// cancels. While a row is dragged the window holds new snapshots (they would replace the rows under the mouse).
import { call } from './bridge';
import { actionError, cancelControls } from './jobs';
import { waitingNote, waitingNotes } from './text';
import type { JobView, Snapshot } from './types';
import { button, chip, el, make, timeSpan } from './ui';

let dragged: string | null = null;
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

function row(j: JobView, index: number, count: number, stale: boolean): HTMLElement {
  const li = make('li', 'wrow');
  li.draggable = !j.pending && !stale;
  const name = make('span', 'file', j.what || j.id);
  name.title = j.what || j.id;
  const line = make('div', 'run-line');
  line.append(chip(j.type), name);
  const pieces: (string | HTMLElement)[] = [`from ${j.owner}`];
  if (j.createdAtMs !== null) pieces.push(' · queued ', timeSpan(j.createdAtMs, 'ago'));
  for (const note of waitingNotes(j)) pieces.push(' · ', make('span', note.bad ? 'bad' : '', note.text));
  const sub = make('div', 'wsub');
  sub.append(...pieces);
  const main = make('div', 'wmain');
  main.append(line, sub, ...actionError(j));
  li.append(
    make('span', 'wpos', String(index + 1)),
    main,
    button(`${j.id} top`, '⤒', 'Move to the top', () => call('move_job', { id: j.id, to: 'top', other: null }), {
      disabled: j.pending || stale || index === 0,
      className: 'icon move',
    }),
    button(`${j.id} bottom`, '⤓', 'Move to the bottom', () => call('move_job', { id: j.id, to: 'bottom', other: null }), {
      disabled: j.pending || stale || index === count - 1,
      className: 'icon move',
    }),
    ...cancelControls(j, { stale, label: '✕', className: 'icon', title: 'Remove from the queue', question: `Cancel the ${j.type} job of ${j.owner}?` }),
  );
  li.addEventListener('dragstart', (e) => {
    dragged = j.id;
    e.dataTransfer?.setData('text/plain', j.id);
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    dragged = null;
    li.classList.remove('dragging');
    clearMarks();
    afterDrag();
  });
  li.addEventListener('dragover', (e) => {
    if (dragged === null || dragged === j.id || stale) return;
    e.preventDefault();
    clearMarks();
    li.classList.add(below(e, li) ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragged === null || dragged === j.id || stale) return;
    call('move_job', { id: dragged, to: below(e, li) ? 'after' : 'before', other: j.id });
  });
  return li;
}

export function renderWaiting(s: Snapshot, stale: boolean): void {
  el('waiting-title').textContent = s.queueKnown ? `Waiting · ${s.queued.length}` : 'Waiting';
  const note = waitingNote(s);
  const noteEl = el('waiting-note');
  noteEl.textContent = note.text;
  noteEl.classList.toggle('lease', note.lease);
  const list = el('waiting');
  if (!s.queued.length) {
    list.replaceChildren(make('li', 'wempty', s.queueKnown ? 'Nothing waits.' : (s.queueNote ?? '')));
    return;
  }
  list.replaceChildren(...s.queued.map((j, i) => row(j, i, s.queued.length, stale)));
}
