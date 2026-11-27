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
import { type DrawKeys, drawPlan } from './draw';
import { renderFooter } from './footer';
import { renderGpu } from './gpu';
import { initHeader, renderHeader } from './header';
import { renderHistory } from './history';
import { forgetConfirm } from './jobs';
import { forgetMenu } from './priority';
import { renderLog } from './log';
import { initQuit, renderQuit } from './quit';
import { renderRunning } from './running';
import { mountSkeleton } from './skeleton';
import { initTabs, tabsDrawn } from './tabs';
import { chooseFocus } from './logic';
import { dayKey } from './text';
import type { Snapshot } from './types';
import { el, setOffset, setRerender, takeAskedFocus, tickTimes } from './ui';
import { isDragging, onDragEnd, renderWaiting } from './waiting';

let current: Snapshot | null = null;
/** The keys of the snapshot last drawn: the core sends one every second even when nothing changed, and redrawing an
 * equal one would close open errors, drop clicks and focus for nothing; the card's numbers redraw only the GPU strip. */
let drawn: DrawKeys | null = null;
/** A snapshot that came during a drag; drawn when it ends. */
let held: Snapshot | null = null;

/** A button that lost the focus because it was disabled (Pause while it waits): it gets it back when it can. */
let wanted: string | undefined;

/** Deferred 06e: the focus stays where the user was, also when an action replaced or disabled the focused button. */
function restoreFocus(focused: string | undefined): void {
  const lost = document.activeElement === null || document.activeElement === document.body;
  const key = chooseFocus({ asked: takeAskedFocus(), focused, wanted, lost });
  wanted = undefined;
  if (key === undefined) return;
  const node = [...document.querySelectorAll<HTMLElement>('[data-key]')].find((n) => n.dataset.key === key);
  if (node instanceof HTMLButtonElement && node.disabled) wanted = key;
  else node?.focus({ preventScroll: true });
}

/** Draws `s`, unless it equals the snapshot drawn last (`force`: the window's own state changed). */
function render(s: Snapshot, force = false): void {
  if (isDragging()) {
    held = s;
    return;
  }
  const plan = drawPlan(drawn, s);
  drawn = plan.keys;
  current = s;
  if (plan.gpu || force) renderGpu(s);
  if (!plan.rest && !force) return;
  setOffset(s.offsetMs);
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;
  const stale = s.serverDownSinceMs !== null || s.serverRefused;
  el('tray').classList.toggle('stale', stale);
  forgetConfirm([s.running, ...s.queued].flatMap((j) => (j ? [j.id] : [])), stale);
  forgetMenu(s.queued.map((j) => j.id), stale);
  renderHeader(s);
  renderRunning(s, stale);
  renderWaiting(s, stale);
  renderHistory(s);
  renderLog(s.log);
  renderFooter(s);
  // The Quit question first: while it is asked the window under it is inert and takes no focus.
  renderQuit(s);
  restoreFocus(focused);
  tabsDrawn();
}

mountSkeleton(el('app'));
setRerender(() => {
  if (current) render(current, true);
});
onDragEnd(() => {
  if (held) {
    const next = held;
    held = null;
    render(next);
  }
});
initHeader();
initQuit();
initTabs();
// At local midnight today's jobs become yesterday's: History redraws though no snapshot changed.
let day = dayKey(Date.now());
setInterval(() => {
  tickTimes();
  const now = dayKey(Date.now());
  if (now === day) return;
  day = now;
  if (current) render(current, true);
}, 1000);

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
