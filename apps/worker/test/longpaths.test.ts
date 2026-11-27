import { expect, test } from 'vitest';
import { longPathsOf } from '../src/longpaths.js';

test('reads LongPathsEnabled from the output of reg query', () => {
  const head = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n';
  expect(longPathsOf(`\r\n${head}    LongPathsEnabled    REG_DWORD    0x1\r\n\r\n`)).toBe(true);
  expect(longPathsOf(`\r\n${head}    LongPathsEnabled    REG_DWORD    0x0\r\n\r\n`)).toBe(false);
  expect(longPathsOf('')).toBe(false);
});
