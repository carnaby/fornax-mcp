import { describe, expect, test } from 'vitest';
import { chooseFocus, errorHeadline, heightToSend, otherTab, storedTab } from './logic';

describe('History error (deferred 06e)', () => {
  test('the summary is the first line with text, not an empty first line', () => {
    expect(errorHeadline('\n\n  render failed: no camera\nmore')).toBe('render failed: no camera');
    expect(errorHeadline('one line')).toBe('one line');
    expect(errorHeadline('  \n ')).toBe('error');
  });
});

describe('focus after a redraw (deferred 06e)', () => {
  test('a key an action asked for wins, then the focused one, then a button that was disabled', () => {
    expect(chooseFocus({ asked: 'Q1 cancel no', focused: 'Q1 cancel', wanted: undefined, lost: false })).toBe('Q1 cancel no');
    expect(chooseFocus({ asked: undefined, focused: 'Q1 cancel', wanted: 'pause', lost: false })).toBe('Q1 cancel');
    // Pause turned disabled while it waits: once it is back, the focus returns, unless the user moved on.
    expect(chooseFocus({ asked: undefined, focused: undefined, wanted: 'pause', lost: true })).toBe('pause');
    expect(chooseFocus({ asked: undefined, focused: undefined, wanted: 'pause', lost: false })).toBeUndefined();
  });
});

describe('tabs (0.12.0, tabs.ts)', () => {
  test('the remembered tab is the log only when stored so', () => {
    expect([storedTab('log'), storedTab('history'), storedTab(null), storedTab('nonsense')]).toEqual(['log', 'history', 'history', 'history']);
    expect([otherTab('history'), otherTab('log')]).toEqual(['log', 'history']);
  });

  test('the closed window sends its height once it drew a snapshot, and only when it changed', () => {
    expect(heightToSend({ open: true, drawn: true, height: 300, sent: 0 })).toBeNull();
    expect(heightToSend({ open: false, drawn: false, height: 300, sent: 0 })).toBeNull();
    expect(heightToSend({ open: false, drawn: true, height: 300, sent: 0 })).toBe(300);
    expect(heightToSend({ open: false, drawn: true, height: 300, sent: 300 })).toBeNull();
    expect(heightToSend({ open: false, drawn: true, height: 340, sent: 300 })).toBe(340);
  });
});
