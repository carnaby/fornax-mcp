// History (spec 06e § 2.6): the finished jobs, newest first; a failed one shows its error's first line, a click shows
// all of it; Result opens the job's result page. Only today and yesterday (0.12.0): yesterday's jobs under a line of
// their own, older ones not at all.
import { call } from './bridge';
import { actionError } from './jobs';
import { errorHeadline } from './logic';
import { historyDays, historySub } from './text';
import type { JobView, Snapshot } from './types';
import { button, el, make } from './ui';

const MARKS: Record<string, string> = { succeeded: '✓', failed: '✗', canceled: '–' };
/** The failed jobs whose error the user opened: the rows are rebuilt on every change, the open errors stay open. */
const expanded = new Set<string>();

function historyRow(j: JobView): HTMLElement {
  const li = make('li', 'hrow');
  const main = make('div', 'hmain');
  main.append(make('span', 'htitle', [j.type, j.what].filter(Boolean).join(' · ')));
  if (j.state === 'failed' && j.error) {
    const details = make('details', 'herror');
    const summary = make('summary', undefined, errorHeadline(j.error));
    summary.dataset.key = `${j.id} error`;
    details.append(summary, make('p', undefined, j.error));
    details.open = expanded.has(j.id);
    details.addEventListener('toggle', () => {
      if (details.open) expanded.add(j.id);
      else expanded.delete(j.id);
    });
    main.append(details);
  } else {
    main.append(make('span', 'hsub', historySub(j)));
  }
  main.append(...actionError(j));
  li.append(
    make('span', `hmark ${j.state}`, MARKS[j.state] ?? '·'),
    main,
    button(`${j.id} result`, 'Result', 'Open the result page', () => call('open_result', { id: j.id }), { className: 'link' }),
  );
  return li;
}

export function renderHistory(s: Snapshot): void {
  for (const id of expanded) if (!s.finished.some((j) => j.id === id)) expanded.delete(id);
  const list = el('history');
  const { today, yesterday } = historyDays(s.finished, Date.now());
  if (!today.length && !yesterday.length) {
    list.replaceChildren(make('li', 'hempty', s.queueKnown ? 'Nothing finished today or yesterday.' : (s.queueNote ?? '')));
    return;
  }
  const rows = today.map(historyRow);
  if (yesterday.length) {
    const line = make('li', 'hday', 'Yesterday');
    line.setAttribute('role', 'presentation');
    rows.push(line, ...yesterday.map(historyRow));
  }
  list.replaceChildren(...rows);
}
