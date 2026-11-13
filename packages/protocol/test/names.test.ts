import { expect, test } from 'vitest';
import { cleanOutputName, isWindowsReservedName } from '../src/names.js';

test('accepts plain relative names', () => {
  expect(cleanOutputName('frame_0001.png')).toBe('frame_0001.png');
  expect(cleanOutputName('previews/frame_0001.jpg')).toBe('previews/frame_0001.jpg');
});

test('refuses traversal, absolute paths, backslashes and odd names', () => {
  for (const bad of ['../x', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', '.hidden', 'a//b', '', 'a/', 'x'.repeat(201), 'a/b/c/d/e/f/g/h/i']) {
    expect(cleanOutputName(bad), bad).toBeNull();
  }
});

test('refuses Windows device names and trailing dots, in any segment', () => {
  for (const bad of ['nul', 'NUL', 'con.txt', 'frames/aux.png', 'com1', 'LPT9.log', 'a.', 'dir./x.png']) {
    expect(cleanOutputName(bad), bad).toBeNull();
  }
  for (const good of ['console.png', 'nullable.txt', 'com10.txt', 'auxiliary/x.png']) {
    expect(cleanOutputName(good), good).toBe(good);
  }
});

test('isWindowsReservedName looks at the part before the first dot', () => {
  expect(isWindowsReservedName('Con.png')).toBe(true);
  expect(isWindowsReservedName('com3')).toBe(true);
  expect(isWindowsReservedName('icon.png')).toBe(false);
});
