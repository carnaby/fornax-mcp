/** What `fornax secrets set` got: the raw text, Ctrl+C, or more than the limit. */
export type SecretInput = { raw: string } | { canceled: true } | { tooLong: true };

/** A terminal's input: raw mode turns its echo off. */
export type RawInput = NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown };

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const ENTER = new Set([String.fromCharCode(13), String.fromCharCode(10)]);
const BACKSPACE = new Set([String.fromCharCode(8), String.fromCharCode(127)]);

/** Spec 08 § 3.1: one line typed or pasted without echo; null when canceled with Ctrl+C. */
export function readHiddenLine(input: RawInput, output: { write(text: string): unknown }, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let value = '';
    const finish = (result: string | null) => {
      input.removeListener('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ENTER.has(ch) || ch === CTRL_D) return finish(value);
        if (ch === CTRL_C) return finish(null);
        if (BACKSPACE.has(ch)) value = Array.from(value).slice(0, -1).join('');
        else value += ch;
      }
    };
    output.write(prompt);
    input.setRawMode?.(true);
    input.on('data', onData);
    input.resume();
  });
}

/** Everything on a piped input, or null when it is larger than `limit` bytes. */
export async function readAllLimited(input: AsyncIterable<Buffer | string>, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of input) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    size += b.length;
    if (size > limit) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}
