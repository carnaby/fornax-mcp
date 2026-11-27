// The Quit question (spec 06e § 2.8): an overlay over the whole window, so it is always seen; Escape keeps running.
import { call } from './bridge';
import type { Snapshot } from './types';
import { el } from './ui';

let shown = false;

export function initQuit(): void {
  el('quit-yes').addEventListener('click', () => call('confirm_quit', { yes: true }));
  el('quit-no').addEventListener('click', () => call('confirm_quit', { yes: false }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shown) call('confirm_quit', { yes: false });
  });
}

/** Drawn last: the question takes the focus when it appears. */
export function renderQuit(s: Snapshot): void {
  el('quit').hidden = !s.confirmQuit;
  // The window under the question cannot be reached with Tab while it is asked (deferred 06e).
  el('tray').inert = s.confirmQuit;
  if (s.confirmQuit && !shown) el('quit-no').focus();
  shown = s.confirmQuit;
}
