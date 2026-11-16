// The footer (spec 06e § 2.7): the worker's types as chips and the versions.
import { chipClass } from './text';
import type { Snapshot, TypeView } from './types';
import { el, make, rerender } from './ui';

/** The unavailable type whose reason is open (the chips are rebuilt on every change). */
let open: string | null = null;

function typeChip(t: TypeView): HTMLElement {
  if (t.state === 'unavailable') {
    const b = make('button', `${chipClass(t.name)} bad`, t.name);
    b.type = 'button';
    b.title = 'Why it is not offered';
    b.dataset.key = `type ${t.name}`;
    b.setAttribute('aria-expanded', String(open === t.name));
    b.addEventListener('click', () => {
      open = open === t.name ? null : t.name;
      rerender();
    });
    return b;
  }
  const chip = make('span', t.state === 'waiting' ? `${chipClass(t.name)} dim` : chipClass(t.name), t.name);
  if (t.state === 'waiting') chip.title = t.reason ?? 'waiting for the card';
  return chip;
}

export function renderFooter(s: Snapshot): void {
  if (open !== null && !s.types.some((t) => t.name === open && t.state === 'unavailable')) open = null;
  const chips = s.types.length ? s.types.map(typeChip) : [make('span', 'muted', s.typesNote ?? 'No type packs are installed.')];
  el('types').replaceChildren(make('span', 'types-label', 'Types'), ...chips);
  const reason = open === null ? null : (s.types.find((t) => t.name === open)?.reason ?? null);
  const p = el('type-reason');
  p.hidden = reason === null;
  p.textContent = reason === null ? '' : `${open}: ${reason}`;
  el('versions').textContent = s.versions;
}
