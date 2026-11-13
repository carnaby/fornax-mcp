import { expect, test } from 'vitest';
import { cleanOutputName } from '../src/names.js';

test('accepts plain relative names', () => {
  expect(cleanOutputName('frame_0001.png')).toBe('frame_0001.png');
  expect(cleanOutputName('previews/frame_0001.jpg')).toBe('previews/frame_0001.jpg');
});

test('refuses traversal, absolute paths, backslashes and odd names', () => {
  for (const bad of ['../x', 'a/../b', '/etc/passwd', 'C:/x', 'a\b', '.hidden', 'a//b', '', 'a/', 'x'.repeat(201), 'a/b/c/d/e/f/g/h/i']) {
    expect(cleanOutputName(bad), bad).toBeNull();
  }
});
