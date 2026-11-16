// The tray window (spec 06e § 2): it draws the snapshots the Rust core sends (event "state") and turns clicks into its
// commands. One module per section; this one decides when to draw.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/inter/latin-ext-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import './style.css';
import { invoke, listen } from './bridge';
import { renderFooter } from './footer';
import { renderGpu } from './gpu';
import { initHeader, renderHeader } from './header';
import { initQuit, renderQuit } from './quit';
import { mountSkeleton } from './skeleton';
import type { Snapshot } from './types';
import { el, setOffset, setRerender, tickTimes } from './ui';

let current: Snapshot | null = null;
/** The snapshot last drawn, as JSON: the core sends one every second even when nothing changed, and redrawing an
 * equal one would close open errors, drop clicks and focus for nothing. */
let drawn = '';

/** Draws `s`, unless it equals the snapshot drawn last (`force`: the window's own state changed). */
function render(s: Snapshot, force = false): void {
  const json = JSON.stringify(s);
  if (!force && json === drawn) return;
  drawn = json;
  current = s;
  setOffset(s.offsetMs);
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;
  const stale = s.serverDownSinceMs !== null || s.serverRefused;
  el('tray').classList.toggle('stale', stale);
  renderHeader(s);
  renderGpu(s);
  renderFooter(s);
  if (focused !== undefined) {
    for (const node of document.querySelectorAll<HTMLElement>('[data-key]')) {
      if (node.dataset.key === focused) node.focus({ preventScroll: true });
    }
  }
  renderQuit(s);
}

mountSkeleton(el('app'));
setRerender(() => {
  if (current) render(current, true);
});
initHeader();
initQuit();
setInterval(tickTimes, 1000);

// The first paint asks for the snapshot; a state event that comes first is newer, and the answer must not undo it.
let painted = false;
listen<Snapshot>('state', (s) => {
  painted = true;
  render(s);
});
invoke<Snapshot>('snapshot')
  .then((s) => {
    if (!painted) render(s);
  })
  .catch(console.error);
