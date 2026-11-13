const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** An output's name: a relative path with "/" that cannot leave the output directory. Null when not acceptable. */
export function cleanOutputName(raw: string): string | null {
  if (raw.length === 0 || raw.length > 200) return null;
  const parts = raw.split('/');
  if (parts.length > 8) return null;
  for (const p of parts) if (!SEGMENT.test(p)) return null;
  return raw;
}
