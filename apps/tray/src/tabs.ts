// The History / Worker log tabs (spec 06e § 2.6): arrow keys switch, the last tab is remembered (only in this
// browser profile; without storage the window starts on History).
import { el } from './ui';

type Tab = 'history' | 'log';
const KEY = 'fornax.tab';
const TABS: Tab[] = ['history', 'log'];
let active: Tab = 'history';

function stored(): Tab {
  try {
    return localStorage.getItem(KEY) === 'log' ? 'log' : 'history';
  } catch {
    return 'history';
  }
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
    el(`panel-${t}`).hidden = t !== tab;
  }
  if (tab === 'log') {
    const panel = el('panel-log');
    panel.scrollTop = panel.scrollHeight;
  }
  if (focus) el(`tab-${tab}`).focus();
}

export function initTabs(): void {
  for (const t of TABS) el(`tab-${t}`).addEventListener('click', () => select(t));
  el('tablist').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    select(active === 'history' ? 'log' : 'history', true);
  });
  select(stored());
}
