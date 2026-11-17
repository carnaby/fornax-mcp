// The priority menu of a waiting or idle job (spec 07 § 5.1): High / Normal / Idle, the current one marked. One menu
// open at a time, on a line of its own under the job; Escape or a choice closes it; the arrow keys move between the items.
import { call } from './bridge';
import type { JobView } from './types';
import { button, make, rerender } from './ui';

/** The job whose menu is open. */
let open: string | null = null;
/** The menu was just opened: show it (the list may scroll) and put the focus on its current item, once. */
let justOpened = false;
const CHOICES = [
  ['high', 'High'],
  ['normal', 'Normal'],
  ['idle', 'Idle'],
] as const;

export function closeMenu(): void {
  open = null;
}

/** Forget the menu when its job is gone or the server cannot be reached. */
export function forgetMenu(ids: string[], stale: boolean): void {
  if (open !== null && (stale || !ids.includes(open))) open = null;
}

/** What opens the menu: the HIGH badge, the row number or ◷. Plain text without the actions (an older fornax). */
export function priorityTrigger(j: JobView, label: string, className: string, o: { stale: boolean; can: boolean }): HTMLElement {
  if (!o.can) return make('span', className, label);
  const b = button(
    `${j.id} priority`,
    label,
    'Priority',
    () => {
      open = open === j.id ? null : j.id;
      justOpened = open !== null;
      rerender();
    },
    { disabled: j.pending || o.stale, className: `${className} prio-button` },
  );
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', String(open === j.id));
  return b;
}

/** The open menu of this job, or nothing. */
export function priorityMenu(j: JobView): HTMLElement[] {
  if (open !== j.id) return [];
  const menu = make('div', 'menu');
  menu.setAttribute('role', 'menu');
  for (const [value, text] of CHOICES) {
    const current = value === j.priority;
    const item = button(
      `${j.id} priority ${value}`,
      current ? `${text} ✓` : text,
      `Set ${value}`,
      () => {
        open = null;
        if (!current) call('set_priority', { id: j.id, priority: value });
        rerender();
      },
      { className: current ? 'menu-item current' : 'menu-item' },
    );
    item.setAttribute('role', 'menuitem');
    menu.append(item);
  }
  if (justOpened) {
    justOpened = false;
    requestAnimationFrame(() => {
      menu.scrollIntoView({ block: 'nearest' });
      menu.querySelector<HTMLButtonElement>('.current')?.focus();
    });
  }
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      open = null;
      rerender();
    } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      items[(at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  return [menu];
}
