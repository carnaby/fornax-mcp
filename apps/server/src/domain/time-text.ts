/** Spec 09 § 4: times the server writes for people, in its own zone (TZ); fields stay ISO in UTC. */

type Parts = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'timeZoneName', string>;

function partsOf(d: Date, zone: string, month: 'short' | '2-digit'): Parts {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month, day: month === 'short' ? 'numeric' : '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value])) as Parts;
}

/** "12:24 CET" on the day of `now` in `zone`, else "16 Nov 23:50 CET". */
export function timeText(d: Date, now: Date, zone: string): string {
  const p = partsOf(d, zone, 'short');
  const n = partsOf(now, zone, 'short');
  const time = `${p.hour}:${p.minute} ${p.timeZoneName}`;
  return p.year === n.year && p.month === n.month && p.day === n.day ? time : `${p.day} ${p.month} ${time}`;
}

/** "2026-11-17 12:24 CET" (the result page). */
export function dateTimeText(d: Date, zone: string): string {
  const p = partsOf(d, zone, '2-digit');
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** The zone of TZ; unset: the process's own; a name Intl does not know: UTC, with the reason for one warning at start. */
export function timeZoneOf(raw: string | undefined): { zone: string; problem: string | null } {
  if (raw === undefined) return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, problem: null };
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: raw });
    return { zone: raw, problem: null };
  } catch {
    return { zone: 'UTC', problem: `TZ ${raw} is not a time zone this server knows; times in sentences are in UTC` };
  }
}
