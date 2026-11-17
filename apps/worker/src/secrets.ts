import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasControlChars } from '@fornax/protocol';
import { ConfigError } from './config.js';

/** Spec 08 § 2.1: a secret's name is also the environment variable a pack's setup gets it as. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_LENGTH = 8192;

/** Variables tools need from the worker's environment: the guard (§ 4.2) would take a secret's name away from every tool. */
const SYSTEM_NAMES = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'USERNAME', 'USER', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMROOT',
  'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'SHELL', 'LANG', 'PYTHONPATH', 'PYTHONHOME',
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
]);

/**
 * Why `name` cannot name a secret, or null. A rejected name is never quoted (it may be the token typed where the name
 * goes), except a system variable, whose name is one of the fixed words above.
 */
export function checkSecretName(name: string): string | null {
  if (SYSTEM_NAMES.has(name.toUpperCase())) return `${name} is a system variable; tools need it, so it cannot be a secret`;
  if (/^fornax_/i.test(name)) return "names starting with FORNAX_ are the worker's own";
  if (SECRET_NAME.test(name)) return null;
  if (SECRET_NAME.test(name.toUpperCase())) return 'secret names are upper case (HF_TOKEN, not hf_token)';
  return 'a secret name is A-Z, 0-9 and "_", starting with a letter, at most 64 characters';
}

export type SecretValue = { value: string } | { problem: string };

export const UTF16_PROBLEM = 'the file is UTF-16; save it as UTF-8';

/** Text saved as UTF-16 (Windows PowerShell 5.1 `>`, Notepad's "Unicode"): a byte-order mark or NUL bytes. */
export const isUtf16 = (b: Buffer): boolean =>
  (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) || b.includes(0);

/** Spec 08 § 2.2: one line, 1 to 8192 characters, no control characters. The problem never quotes the value or its length. */
export function parseSecretValue(raw: string): SecretValue {
  // A byte-order mark (a token file saved by a Windows editor) is not part of the value.
  const value = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
  if (!value) return { problem: 'the value is empty' };
  if (/[\r\n]/.test(value)) return { problem: 'the value must be one line' };
  if (hasControlChars(value)) return { problem: 'the value holds control characters' };
  if (value.length > MAX_SECRET_LENGTH) return { problem: `the value is longer than ${MAX_SECRET_LENGTH} characters` };
  return { value };
}

export const secretFile = (secretsDir: string, name: string): string => join(secretsDir, name);

/** The stored value, null when there is none; a ConfigError naming the file (never its content) when it is unusable. */
export function readSecret(secretsDir: string, name: string): string | null {
  const file = secretFile(secretsDir, name);
  const again = `set it again with fornax secrets set ${name}`;
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new ConfigError(`secret ${name}: ${file} cannot be read (${code ?? 'error'}); ${again}`);
  }
  // Final review #5: a UTF-16 file is named as such, not as "control characters".
  const r = isUtf16(raw) ? { problem: UTF16_PROBLEM } : parseSecretValue(raw.toString('utf8'));
  if ('problem' in r) throw new ConfigError(`secret ${name}: ${file} does not hold a valid value (${r.problem}); ${again}`);
  return r.value;
}

/** Spec 08 § 2: through a temporary file and a rename, so a cut-short write never leaves half a value; 0700/0600 on Linux. */
export function writeSecret(secretsDir: string, name: string, value: string): string {
  const linux = process.platform !== 'win32';
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  // The modes apply only when created; an older directory or file keeps its own otherwise.
  if (linux) chmodSync(secretsDir, 0o700);
  const file = secretFile(secretsDir, name);
  const tmp = join(secretsDir, `.${name}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
    if (linux) chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return file;
}

/** false when there was no such secret. */
export function removeSecret(secretsDir: string, name: string): boolean {
  const file = secretFile(secretsDir, name);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * Final review #8: a symlink to a file is used by the setup, so it counts as stored. A loop or a target that cannot be
 * read (ELOOP, EACCES) is not one, and must not break the listing (final review #6).
 */
function linksToFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** Names of the stored secrets: files whose names pass checkSecretName (temporary files and others are not secrets). */
export function storedSecretNames(secretsDir: string): string[] {
  if (!existsSync(secretsDir)) return [];
  return readdirSync(secretsDir, { withFileTypes: true })
    .filter((d) => (d.isFile() || (d.isSymbolicLink() && linksToFile(join(secretsDir, d.name)))) && checkSecretName(d.name) === null)
    .map((d) => d.name)
    .sort();
}
