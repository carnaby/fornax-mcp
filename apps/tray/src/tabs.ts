// The History / Worker log tabs (spec 06e § 2.6): arrow keys switch, the last tab is remembered (only in this
// browser profile; without storage the window starts on History). 0.12.0: the arrow closes the card and the window
// becomes as high as what it still shows; the core remembers it open or closed (window.rs) with the window's size and
// place.
import { call, invoke } from './bridge';
import { heightToSend, otherTab, storedTab, type Tab } from './logic';
import { el } from './ui';

const KEY = 'fornax.tab';
const TABS: Tab[] = ['history', 'log'];
let active: Tab = 'history';
let open = true;
/** The height last sent for the closed window: the window resizes only when what it shows changes. */
let sentHeight = 0;
/** Not before the first snapshot is drawn: the bare skeleton would shrink the window, the snapshot grow it again. */
let drawn = false;

function stored(): Tab {
  try {
    return storedTab(localStorage.getItem(KEY));
  } catch {
    return 'history';
  }
}

function showPanels(): void {
  for (const t of TABS) el(`panel-${t}`).hidden = !open || t !== active;
}

function select(tab: Tab, focus = false): void {
  active = tab;
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    // Not remembered: the window starts on History next time.
  }
  for (const t of TABS) {
    const b = el(`tab-${t}`);
    b.setAttribute('aria-selected', String(t === tab));
    b.tabIndex = t === tab ? 0 : -1;
  }
  showPanels();
  if (tab === 'log' && open) {
    const panel = el('panel-log');
    panel.scrollTop = panel.scrollHeight;
  }
  if (focus) el(`tab-${tab}`).focus();
}

/** The closed window's height: what it shows, in CSS pixels (the window's logical pixels). */
const measured = (): number => Math.ceil(el('tray').getBoundingClientRect().height);

/** Closed: tells the core the window's new height, when it changed. */
function fit(): void {
  if (open || !drawn) return;
  const height = heightToSend({ open, drawn, height: measured(), sent: sentHeight });
  if (height === null) return;
  sentHeight = height;
  call('set_history', { open: false, height });
}

function setOpen(next: boolean): void {
  open = next;
  el('tray').classList.toggle('history-closed', !open);
  const toggle = el('history-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide History and Worker log' : 'Show History and Worker log';
  toggle.setAttribute('aria-label', toggle.title);
  showPanels();
  if (open) {
    sentHeight = 0;
    call('set_history', { open: true });
    if (active === 'log') {
      const panel = el('panel-log');
      panel.scrollTop = panel.scrollHeight;
    }
  } else {
    fit();
  }
}

/** The window drew its first snapshot: the closed window may now take its height. */
export function tabsDrawn(): void {
  if (drawn) return;
  drawn = true;
  fit();
}

export function initTabs(): void {
  for (const t of TABS) {
    el(`tab-${t}`).addEventListener('click', () => {
      select(t);
      if (!open) setOpen(true);
    });
  }
  el('tablist').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    select(otherTab(active), true);
  });
  el('history-toggle').addEventListener('click', () => setOpen(!open));
  // Closed, the window follows what it shows: a waiting job, a banner.
  new ResizeObserver(fit).observe(el('tray'));
  select(stored());
  invoke<boolean>('history_open')
    .then((remembered) => {
      if (remembered === false) setOpen(false);
    })
    .catch(console.error);
}
