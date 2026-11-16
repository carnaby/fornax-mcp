// DOM helpers of the tray window (spec 06e § 2.9): elements, buttons, type chips, counting times, and the hook that
// draws the current snapshot again after a change of the window's own state.
import { ago, chipClass, duration, etaMs, uptime } from './text';

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing in the window's skeleton`);
  return found as T;
}

export function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `key` (job id and action) finds the button again after a redraw, so that the focus stays on it. */
export function button(
  key: string,
  text: string,
  title: string,
  onClick: () => void,
  o: { disabled?: boolean; className?: string } = {},
): HTMLButtonElement {
  const b = make('button', o.className, text);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.disabled = o.disabled ?? false;
  b.dataset.key = key;
  b.addEventListener('click', onClick);
  return b;
}

/** A type chip (spec 06e § 2.1). */
export const chip = (type: string, extra?: string): HTMLElement => make('span', extra ? `${chipClass(type)} ${extra}` : chipClass(type), type);

let offsetMs = 0;
/** The server's clock now: the PC's corrected by the offset the core measured at the last queue line. */
export const serverNow = (): number => Date.now() + offsetMs;
export function setOffset(ms: number): void {
  offsetMs = ms;
}

export type TimeFormat = 'duration' | 'ago' | 'uptime' | 'left';

function timeText(span: HTMLElement): string {
  const from = Number(span.dataset.from);
  switch (span.dataset.format) {
    case 'uptime':
      // workerSinceMs is the PC's time, not the server's.
      return uptime(Date.now() - from);
    case 'ago':
      return ago(serverNow() - from);
    case 'left': {
      const left = etaMs(serverNow() - from, Number(span.dataset.progress));
      return left === null ? '' : ` · ~${duration(left)} left`;
    }
    default:
      return duration(serverNow() - from);
  }
}

/** A time that counts from `fromMs`; tickTimes() refreshes it every second. */
export function timeSpan(fromMs: number, format: TimeFormat, progress: number | null = null): HTMLElement {
  const span = make('span', 'time');
  span.dataset.from = String(fromMs);
  span.dataset.format = format;
  if (progress !== null) span.dataset.progress = String(progress);
  span.textContent = timeText(span);
  return span;
}

export function tickTimes(): void {
  for (const span of document.querySelectorAll<HTMLElement>('[data-format]')) span.textContent = timeText(span);
}

let rerenderHook: () => void = () => {};
export function setRerender(hook: () => void): void {
  rerenderHook = hook;
}
/** Draws the current snapshot again (an open question, an opened reason). */
export const rerender = (): void => rerenderHook();
