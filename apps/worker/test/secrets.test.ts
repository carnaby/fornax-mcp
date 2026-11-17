import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ConfigError } from '../src/config.js';
import { checkSecretName, parseSecretValue, readSecret, removeSecret, secretFile, storedSecretNames, writeSecret } from '../src/secrets.js';
import { useTempDir } from './helpers.js';

const tmp = useTempDir();
const VALUE = 'hf_test_value_123';

describe('secret names (spec 08 § 2.1)', () => {
  test('upper case, digits and _, starting with a letter, at most 64 characters', () => {
    for (const ok of ['HF_TOKEN', 'EXAMPLE_TOKEN', 'A', `A${'B'.repeat(63)}`]) expect(checkSecretName(ok), ok).toBeNull();
    for (const bad of ['', '_X', '1X', 'HF-TOKEN', 'HF TOKEN', `A${'B'.repeat(64)}`, '../X']) expect(checkSecretName(bad), bad).not.toBeNull();
  });

  test('FORNAX_* and system variables are refused in any letter case', () => {
    expect(checkSecretName('FORNAX_X')).toMatch(/FORNAX_/);
    expect(checkSecretName('PATH')).toBe('PATH is a system variable; tools need it, so it cannot be a secret');
    expect(checkSecretName('Path')).toBe('Path is a system variable; tools need it, so it cannot be a secret');
    for (const n of ['LD_PRELOAD', 'PYTHONPATH', 'SYSTEMROOT', 'TEMP', 'XDG_CACHE_HOME']) expect(checkSecretName(n), n).toMatch(/system variable/);
  });

  test('a rejected name is never quoted (it may be the token typed in the wrong place)', () => {
    const lower = checkSecretName(VALUE)!;
    expect(lower).toBe('secret names are upper case (HF_TOKEN, not hf_token)');
    expect(lower.toLowerCase()).not.toContain('test_value');
    expect(checkSecretName('hf-test-value')!).not.toContain('test');
  });
});

describe('secret values (spec 08 § 2.2)', () => {
  test('file noise around the value is dropped: a line end, spaces, a byte-order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    for (const raw of [VALUE, `${VALUE}\n`, `${VALUE}\r\n`, `  ${VALUE}  \n`, `${bom}${VALUE}\r\n`]) {
      expect(parseSecretValue(raw), JSON.stringify(raw)).toEqual({ value: VALUE });
    }
  });

  test('empty, several lines, control characters and over 8192 characters are refused without quoting the value', () => {
    expect(parseSecretValue('')).toEqual({ problem: 'the value is empty' });
    expect(parseSecretValue(' \r\n')).toEqual({ problem: 'the value is empty' });
    expect(parseSecretValue(`${VALUE}\nsecond`)).toEqual({ problem: 'the value must be one line' });
    expect(parseSecretValue(`hf${String.fromCharCode(27)}x`)).toEqual({ problem: 'the value holds control characters' });
    // U+2028 is neither CR nor LF: a control character, not a second line.
    expect(parseSecretValue(`hf${String.fromCharCode(0x2028)}x`)).toEqual({ problem: 'the value holds control characters' });
    expect(parseSecretValue('x'.repeat(8192))).toEqual({ value: 'x'.repeat(8192) });
    expect(parseSecretValue('x'.repeat(8193))).toEqual({ problem: 'the value is longer than 8192 characters' });
  });
});

describe('secret files (spec 08 § 2)', () => {
  test('write, read, list and remove; the file holds the value and a line end', () => {
    const dir = join(tmp(), 'secrets');
    expect(storedSecretNames(dir)).toEqual([]);
    expect(readSecret(dir, 'EXAMPLE_TOKEN')).toBeNull();
    const file = writeSecret(dir, 'EXAMPLE_TOKEN', VALUE);
    expect(file).toBe(secretFile(dir, 'EXAMPLE_TOKEN'));
    expect(readFileSync(file, 'utf8')).toBe(`${VALUE}\n`);
    expect(readSecret(dir, 'EXAMPLE_TOKEN')).toBe(VALUE);
    writeSecret(dir, 'OTHER_TOKEN', 'second');
    writeSecret(dir, 'EXAMPLE_TOKEN', 'rotated');
    expect(readSecret(dir, 'EXAMPLE_TOKEN')).toBe('rotated');
    // Only the two files: no temporary file stays behind.
    expect(readdirSync(dir).sort()).toEqual(['EXAMPLE_TOKEN', 'OTHER_TOKEN']);
    expect(storedSecretNames(dir)).toEqual(['EXAMPLE_TOKEN', 'OTHER_TOKEN']);
    expect(removeSecret(dir, 'EXAMPLE_TOKEN')).toBe(true);
    expect(removeSecret(dir, 'EXAMPLE_TOKEN')).toBe(false);
    expect(storedSecretNames(dir)).toEqual(['OTHER_TOKEN']);
  });

  test('files that are not valid names are not secrets', () => {
    const dir = join(tmp(), 'secrets');
    mkdirSync(dir, { recursive: true });
    for (const f of ['.EXAMPLE_TOKEN.123.tmp', 'lower', 'PATH', 'README.md']) writeFileSync(join(dir, f), 'x\n');
    mkdirSync(join(dir, 'DIR_NAME'));
    expect(storedSecretNames(dir)).toEqual([]);
  });

  test('a damaged file is a ConfigError that names the file and the secret, never the content', () => {
    const dir = join(tmp(), 'secrets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'EXAMPLE_TOKEN'), `${VALUE}\nsecond line\n`);
    expect(() => readSecret(dir, 'EXAMPLE_TOKEN')).toThrow(ConfigError);
    let message = '';
    try {
      readSecret(dir, 'EXAMPLE_TOKEN');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.startsWith('secret EXAMPLE_TOKEN: ')).toBe(true);
    expect(message).toContain(join(dir, 'EXAMPLE_TOKEN'));
    expect(message).toContain('fornax secrets set EXAMPLE_TOKEN');
    expect(message).not.toContain(VALUE);
  });

  test.skipIf(process.platform === 'win32')('Linux: directory 0700, file 0600, also when they existed with wider modes', () => {
    const dir = join(tmp(), 'secrets');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, 'EXAMPLE_TOKEN'), 'old\n', { mode: 0o644 });
    const file = writeSecret(dir, 'EXAMPLE_TOKEN', VALUE);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(true);
  });
});

describe('spec 08 final review minors', () => {
  test('#5 a UTF-16 file is named as such, never quoted', () => {
    const dir = join(tmp(), 'secrets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'EXAMPLE_TOKEN'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${VALUE}\r\n`, 'utf16le')]));
    expect(() => readSecret(dir, 'EXAMPLE_TOKEN')).toThrow(/does not hold a valid value \(the file is UTF-16; save it as UTF-8\)/);
    writeFileSync(join(dir, 'OTHER_TOKEN'), Buffer.from(`${VALUE}\n`, 'utf16le'));
    expect(() => readSecret(dir, 'OTHER_TOKEN')).toThrow(/the file is UTF-16; save it as UTF-8/);
  });

  test.skipIf(process.platform === 'win32')('#8 a symlink to a file is a stored secret; a dangling one is not', () => {
    const dir = join(tmp(), 'secrets');
    mkdirSync(dir, { recursive: true });
    const target = join(tmp(), 'elsewhere');
    writeFileSync(target, `${VALUE}\n`);
    symlinkSync(target, join(dir, 'EXAMPLE_TOKEN'));
    symlinkSync(join(tmp(), 'missing'), join(dir, 'OTHER_TOKEN'));
    expect(storedSecretNames(dir)).toEqual(['EXAMPLE_TOKEN']);
  });
});
