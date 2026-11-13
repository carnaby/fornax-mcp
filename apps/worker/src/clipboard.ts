import { spawnSync } from 'node:child_process';

/** Run a clipboard program with `input` on stdin; true when it took it. */
export type ClipboardRunner = (cmd: string, args: string[], input: Buffer) => boolean;

const runQuietly: ClipboardRunner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
  return r.error === undefined && r.status === 0;
};

/** Clipboard programs to try, in order (spec 7.3). */
export function clipboardCommands(platform: NodeJS.Platform): [string, string[]][] {
  return platform === 'win32' ? [['clip.exe', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
}

/** Copy text; the program that took it, or null when none could (the caller prints the text anyway). */
export function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform, run: ClipboardRunner = runQuietly): string | null {
  // clip.exe reads UTF-16LE when the text starts with a byte order mark; a code page would garble non-ASCII paths.
  const input = platform === 'win32' ? Buffer.from(`\ufeff${text}`, 'utf16le') : Buffer.from(text, 'utf8');
  for (const [cmd, args] of clipboardCommands(platform)) if (run(cmd, args, input)) return cmd;
  return null;
}
