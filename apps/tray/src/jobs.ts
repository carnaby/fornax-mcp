// What a job's row offers (spec 06e § 2.4–2.5, spec 07 § 5.3): an action asked with a second click (cancel, requeue,
// pause), and the error of its last action.
import { call } from './bridge';
import type { JobView } from './types';
import { button, focusAfterDraw, make, rerender } from './ui';

/** The job and action whose question waits for Yes ("<id> <action>"; one at a time). */
let confirming: string | null = null;

/** Forget the question when its job is gone or the server cannot be reached. */
export function forgetConfirm(ids: string[], stale: boolean): void {
  if (confirming !== null && (stale || !ids.includes(confirming.split(' ')[0]!))) confirming = null;
}

export type ConfirmText = {
  stale: boolean;
  label: string;
  className: string;
  title: string;
  question: string;
  /** What Yes calls; cancel_job by default. */
  command?: string;
  args?: Record<string, unknown>;
  /** The second part of the key; "cancel" by default. */
  action?: string;
};

export function confirmControls(j: JobView, o: ConfirmText): HTMLElement[] {
  const key = `${j.id} ${o.action ?? 'cancel'}`;
  if (confirming !== key) {
    return [
      button(key, o.label, o.title, () => {
        confirming = key;
        focusAfterDraw(`${key} no`);
        rerender();
      }, { disabled: j.pending || o.stale, className: o.className }),
    ];
  }
  // Answered or dismissed (Escape too, deferred 06e): the focus goes back to the button that asked.
  const close = () => {
    confirming = null;
    focusAfterDraw(key);
    rerender();
  };
  const box = make('span', 'confirm');
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  box.append(
    make('span', undefined, o.question),
    button(`${key} yes`, 'Yes', o.title, () => {
      call(o.command ?? 'cancel_job', o.args ?? { id: j.id });
      close();
    }),
    button(`${key} no`, 'No', 'Keep it', close),
  );
  return [box];
}

export type CancelText = Omit<ConfirmText, 'command' | 'args' | 'action'>;

/** Cancel (spec 06e): the same question, the job's cancel_job. */
export const cancelControls = (j: JobView, o: CancelText): HTMLElement[] => confirmControls(j, o);

export const actionError = (j: JobView): HTMLElement[] => (j.actionError ? [make('p', 'action-error', j.actionError)] : []);
