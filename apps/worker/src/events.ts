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
