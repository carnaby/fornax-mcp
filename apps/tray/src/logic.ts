// Small decisions of the window kept apart from the DOM, so that they are tested (logic.test.ts): the History error's
// summary, where the focus goes after a redraw, and the tabs' memory and height (tabs.ts).

/** History's summary of an error: its first line with text (an error may start with an empty line). */
export function errorHeadline(error: string): string {
  return error.split('\n').map((l) => l.trim()).find(Boolean) ?? 'error';
}

/**
 * The button to focus after a redraw: the one an action asked for (✕ asks for No, Yes and No for ✕ again), else the
 * one that had the focus, else one that lost it while it was disabled (Pause while it waits), but only when the focus
 * is lost now (`lost`: nothing else has it), so a user who moved on keeps their place.
 */
export function chooseFocus(o: { asked: string | undefined; focused: string | undefined; wanted: string | undefined; lost: boolean }): string | undefined {
  return o.asked ?? o.focused ?? (o.lost ? o.wanted : undefined);
}

export type Tab = 'history' | 'log';

/** The tab remembered in storage: the log only when stored so. */
export const storedTab = (raw: string | null): Tab => (raw === 'log' ? 'log' : 'history');

export const otherTab = (tab: Tab): Tab => (tab === 'history' ? 'log' : 'history');

/** The closed window's height to send to the core: only after the first snapshot is drawn and when it changed. */
export function heightToSend(o: { open: boolean; drawn: boolean; height: number; sent: number }): number | null {
  if (o.open || !o.drawn || o.height === o.sent) return null;
  return o.height;
}
