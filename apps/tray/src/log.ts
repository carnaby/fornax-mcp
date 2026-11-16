// Worker log (spec 06e § 2.6): the tray's log; it stays at its newest line until the user scrolls up.
import type { LogLine } from './types';
import { el, make } from './ui';

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function renderLog(lines: LogLine[]): void {
  const panel = el('panel-log');
  const atEnd = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24;
  el('log').replaceChildren(
    ...lines.map((line) => {
      const item = make('li');
      item.classList.toggle('error', line.error);
      item.append(make('time', undefined, time(line.atMs)), line.text);
      return item;
    }),
  );
  if (atEnd) panel.scrollTop = panel.scrollHeight;
}
