// Running (spec 06e § 2.4): the job card with its progress and time left, the lease card, or why nothing runs.
import { actionError, cancelControls } from './jobs';
import { clock, nothingRuns, progressText } from './text';
import type { JobView, Snapshot } from './types';
import { chip, el, make, timeSpan } from './ui';

const KEY_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="M10.7 12.3 21 2"></path><path d="m16 7 3 3"></path><path d="m19 4 2 2"></path></svg>';

function fileName(j: JobView): HTMLElement {
  const name = make('span', 'file', j.what || j.id);
  name.title = j.what || j.id;
  return name;
}

function jobCard(j: JobView, stale: boolean): HTMLElement[] {
  const card = make('div', 'run-card');
  const top = make('div', 'run-top');
  const left = make('div', 'run-left');
  const line = make('div', 'run-line');
  line.append(chip(j.type), fileName(j));
  left.append(line, make('span', 'sub', `from ${j.owner}${j.startedAtMs === null ? '' : ` · started ${clock(j.startedAtMs)}`}`));
  top.append(
    left,
    ...cancelControls(j, {
      stale,
      label: '✕',
      className: 'icon',
      title: 'Cancel this job',
      question: `Cancel the ${j.type} job of ${j.owner}? It stops within a few seconds.`,
    }),
  );
  card.append(top);
  if (j.progress !== null) {
    const track = make('div', 'track');
    const fill = make('div');
    fill.style.width = `${Math.round(j.progress * 100)}%`;
    track.append(fill);
    card.append(track);
  }
  const right = make('span', 'mono');
  if (j.startedAtMs !== null) {
    right.append(timeSpan(j.startedAtMs, 'duration'));
    if (j.progress !== null) right.append(timeSpan(j.startedAtMs, 'left', j.progress));
  }
  const meta = make('div', 'run-meta');
  meta.append(make('span', 'mono', progressText(j.progressMessage, j.progress)), right);
  card.append(meta);
  return [card, ...actionError(j)];
}

function cell(label: string, value: string | HTMLElement): HTMLElement {
  const c = make('div', 'cell');
  const v = make('span', 'cell-value');
  v.append(value);
  c.append(make('span', 'cell-label', label), v);
  return c;
}

function leaseCard(j: JobView, stale: boolean): HTMLElement[] {
  const card = make('div', 'run-card lease-card');
  const icon = make('span', 'lease-icon');
  icon.innerHTML = KEY_ICON;
  const names = make('div', 'run-left');
  names.append(make('span', 'lease-title', `GPU leased by ${j.owner}`), fileName(j));
  const top = make('div', 'lease-top');
  top.append(icon, names);
  const cells = make('div', 'cells');
  cells.append(
    cell('Held', j.startedAtMs === null ? '–' : timeSpan(j.startedAtMs, 'duration')),
    cell('Started', j.startedAtMs === null ? '–' : clock(j.startedAtMs)),
  );
  const bottom = make('div', 'lease-bottom');
  bottom.append(
    make('span', 'sub', 'No progress for leases: the agent runs its own program.'),
    ...cancelControls(j, {
      stale,
      label: 'Revoke',
      className: 'revoke',
      title: 'Revoke the lease',
      question: `Revoke the lease of ${j.owner}? Its program is stopped.`,
    }),
  );
  card.append(top, cells, bottom);
  return [card, ...actionError(j)];
}

export function renderRunning(s: Snapshot, stale: boolean): void {
  const box = el('running');
  const j = s.running;
  if (!j) {
    box.replaceChildren(make('div', 'empty', nothingRuns(s)));
    return;
  }
  box.replaceChildren(...(j.type === 'lease' ? leaseCard(j, stale) : jobCard(j, stale)));
}
