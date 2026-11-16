import { createInterface } from 'node:readline';
import type { TypeState } from './loop.js';

/**
 * Calls `onEnd` once when `input` ends, closes or fails: `fornax queue --json --watch` under the tray ends when the
 * tray is gone (spec 06 3.1). The returned cleanup stops listening and closes the input, so the process can exit.
 */
export function onInputEnd(input: NodeJS.ReadableStream, onEnd: () => void): () => void {
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    onEnd();
  };
  input.on('end', end);
  input.on('close', end);
  input.on('error', end);
  input.resume();
  return () => {
    done = true;
    input.off('end', end);
    input.off('close', end);
    input.off('error', end);
    (input as { destroy?: () => void }).destroy?.();
  };
}

/** Spec 06 3.2 and 06c 2.2: what `fornax worker --events` writes to stdout, one JSON object per line. */
export type WorkerEvent =
  | { event: 'started'; version: string; pid: number }
  | { event: 'log'; line: string }
  | { event: 'types'; types: TypeState[] }
  | { event: 'restarting' }
  | { event: 'stopped'; code: number };

export const eventLine = (e: WorkerEvent): string => `${JSON.stringify(e)}\n`;

/**
 * Spec 06 3.2: the tray's stop channel. Every line "stop" (blanks and a CR around it allowed) calls `onStop`; the end
 * of the input calls `onEnd` (by default one more stop) when no stop line came before (the tray is gone). A caller
 * whose stops also come by signal passes an `onEnd` that checks whether one did: the end is no second stop. The cleanup
 * is no stop; it closes the input so the process can exit.
 */
export function readStops(input: NodeJS.ReadableStream, onStop: () => void, onEnd: () => void = onStop): () => void {
  let stops = 0;
  let cleaning = false;
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() !== 'stop') return;
    stops++;
    onStop();
  });
  lines.on('close', () => {
    if (cleaning || stops > 0) return;
    stops++;
    onEnd();
  });
  input.on('error', () => lines.close());
  return () => {
    cleaning = true;
    lines.close();
    (input as { destroy?: () => void }).destroy?.();
  };
}
