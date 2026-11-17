import { expect, test } from 'vitest';
import { dateTimeText, timeText, timeZoneOf } from '../src/domain/time-text.js';

const at = (iso: string) => new Date(iso);

test('the same day: the time and the zone; another day: the day and month too (spec 09 § 4)', () => {
  expect(timeText(at('2026-11-17T11:24:00Z'), at('2026-11-17T20:00:00Z'), 'Europe/Bratislava')).toBe('12:24 CET');
  expect(timeText(at('2026-11-16T22:50:00Z'), at('2026-11-17T08:00:00Z'), 'Europe/Bratislava')).toBe('16 Nov 23:50 CET');
  expect(timeText(at('2026-11-17T10:00:00Z'), at('2026-11-17T10:01:31Z'), 'UTC')).toBe('10:00 UTC');
});

test("the day is the zone's day", () => {
  // 23:30 UTC is already 00:30 of the next day in Bratislava, the same day as `now` there.
  expect(timeText(at('2026-11-16T23:30:00Z'), at('2026-11-17T08:00:00Z'), 'Europe/Bratislava')).toBe('00:30 CET');
  expect(timeText(at('2026-11-16T23:30:00Z'), at('2026-11-17T08:00:00Z'), 'UTC')).toBe('16 Nov 23:30 UTC');
});

test('summer time, and a zone without a short name', () => {
  expect(timeText(at('2026-07-01T11:24:00Z'), at('2026-07-01T12:00:00Z'), 'Europe/Bratislava')).toBe('13:24 CEST');
  expect(timeText(at('2026-11-17T11:24:00Z'), at('2026-11-17T11:30:00Z'), 'Asia/Kolkata')).toBe('16:54 GMT+5:30');
});

test('the result page: date, time and zone', () => {
  expect(dateTimeText(at('2026-11-17T11:24:00Z'), 'Europe/Bratislava')).toBe('2026-11-17 12:24 CET');
  expect(dateTimeText(at('2026-01-05T00:05:00Z'), 'UTC')).toBe('2026-01-05 00:05 UTC');
});

test('TZ: a known zone is taken, an unknown one is UTC with a reason, none is the system zone', () => {
  expect(timeZoneOf('Europe/Bratislava')).toEqual({ zone: 'Europe/Bratislava', problem: null });
  expect(timeZoneOf('Nowhere/Else')).toEqual({ zone: 'UTC', problem: 'TZ Nowhere/Else is not a time zone this server knows; times in sentences are in UTC' });
  expect(timeZoneOf(undefined)).toEqual({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, problem: null });
});
