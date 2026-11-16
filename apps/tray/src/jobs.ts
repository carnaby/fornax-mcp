// What a job's row offers (spec 06e § 2.4–2.5): cancel with a second click, and the error of its last action.
import { call } from './bridge';
import type { JobView } from './types';
import { button, make, rerender } from './ui';

/** The job whose cancel waits for its second click (one at a time). */
let confirming: string | null = null;

/** Forget the question when its job is gone or the server cannot be reached. */
export function forgetConfirm(ids: string[], stale: boolean): void {
  if (confirming !== null && (stale || !ids.includes(confirming))) confirming = null;
}

export type CancelText = { stale: boolean; label: string; className: string; title: string; question: string };

export function cancelControls(j: JobView, o: CancelText): HTMLElement[] {
  if (confirming !== j.id) {
    return [
      button(`${j.id} cancel`, o.label, o.title, () => {
        confirming = j.id;
        rerender();
      }, { disabled: j.pending || o.stale, className: o.className }),
    ];
  }
  const box = make('span', 'confirm');
  box.append(
    make('span', undefined, o.question),
    button(`${j.id} yes`, 'Yes', o.title, () => {
      confirming = null;
      call('cancel_job', { id: j.id });
      rerender();
    }),
    button(`${j.id} no`, 'No', 'Keep it', () => {
      confirming = null;
      rerender();
    }),
  );
  return [box];
}

export const actionError = (j: JobView): HTMLElement[] => (j.actionError ? [make('p', 'action-error', j.actionError)] : []);
