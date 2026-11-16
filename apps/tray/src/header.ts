// The header (spec 06e § 2.2): status, the second line, Pause/Resume, Start/Stop, and the banners. Never scrolls.
import { call } from './bridge';
import { clock } from './text';
import type { Snapshot } from './types';
import { el, timeSpan } from './ui';

let latest: Snapshot | null = null;

export function initHeader(): void {
  el('pause').addEventListener('click', () => call('set_paused', { paused: !(latest?.paused ?? false) }));
  el('worker').addEventListener('click', () => call(latest?.canStop ? 'stop_worker' : 'start_worker'));
  el('update-button').addEventListener('click', () => call('update'));
  el('cancel-update').addEventListener('click', () => call('cancel_update'));
}

function show(id: string, text: string | null): void {
  const node = el(id);
  node.hidden = !text;
  node.textContent = text ?? '';
}

export function renderHeader(s: Snapshot): void {
  latest = s;
  el('status').dataset.tone = s.status.tone;
  el('status-label').textContent = s.status.label;
  const worker: (string | HTMLElement)[] = s.workerSinceMs === null ? [s.workerText] : ['Worker up ', timeSpan(s.workerSinceMs, 'uptime')];
  el('status-line').replaceChildren(...worker, ...(s.queueText ? [` · ${s.queueText}`] : []));
  const pause = el<HTMLButtonElement>('pause');
  pause.disabled = !s.canPause;
  pause.textContent = s.pauseLabel;
  const workerButton = el<HTMLButtonElement>('worker');
  if (s.canStop) {
    workerButton.textContent = s.stopLabel;
    workerButton.className = 'outline danger';
    workerButton.disabled = false;
  } else {
    workerButton.textContent = 'Start worker';
    workerButton.className = 'outline go';
    workerButton.disabled = !s.canStart;
  }
  const down = s.serverDownSinceMs !== null ? `Server unreachable since ${clock(s.serverDownSinceMs)}${s.serverMessage ? ` (${s.serverMessage})` : ''}` : null;
  show('server', s.serverRefused ? s.serverMessage : down);
  show('note', s.note);
  show('pause-error', s.pauseError);
  const offered = s.updateLabel !== null;
  el('update').hidden = !offered && !s.updating && s.updateNote === null;
  show('update-text', s.updating ? s.headline : offered ? 'A new version is available.' : null);
  const update = el<HTMLButtonElement>('update-button');
  update.hidden = !offered;
  update.disabled = !s.canUpdate;
  update.textContent = s.updateLabel ?? '';
  el('cancel-update').hidden = !s.canCancelUpdate;
  show('update-note', s.updateNote);
}
