const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A name Windows reserves for a device (CON, NUL, COM1…), with or without an extension: such a file cannot exist there. */
export function isWindowsReservedName(segment: string): boolean {
  return WINDOWS_DEVICE.test(segment.split('.')[0] ?? '');
}

/**
 * An output's name: a relative path with "/" that cannot leave the output directory and can be a file on Windows
 * and Linux alike (no device names, no trailing dot, which Windows strips). Null when not acceptable.
 */
export function cleanOutputName(raw: string): string | null {
  if (raw.length === 0 || raw.length > 200) return null;
  const parts = raw.split('/');
  if (parts.length > 8) return null;
  for (const p of parts) {
    if (!SEGMENT.test(p) || p.endsWith('.') || isWindowsReservedName(p)) return null;
  }
  return raw;
}
