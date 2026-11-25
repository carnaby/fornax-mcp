/**
 * Spec 14 § 6.1: a window of a UTF-8 file for get_output. `buf` holds bytes [start, start + buf.length) of a file of
 * `size` bytes. The window starts after a character the start cuts, ends before a character the end cuts, and when a
 * line break lies in its last quarter, right after the last one. nextOffset is where the next window starts; null at the
 * end of the file.
 */
export function textWindow(buf: Buffer, start: number, size: number): { text: string; offset: number; nextOffset: number | null; binary: boolean } {
  let from = 0;
  if (start > 0) while (from < 3 && from < buf.length && ((buf[from] ?? 0) & 0xc0) === 0x80) from++;
  let to = buf.length;
  const reachesEnd = start + buf.length >= size;
  if (!reachesEnd && to > from) {
    let lead = to - 1;
    while (lead > from && to - lead < 4 && ((buf[lead] ?? 0) & 0xc0) === 0x80) lead--;
    const b = buf[lead] ?? 0;
    const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (to - lead < length) to = lead;
    const lineBreak = buf.lastIndexOf(0x0a, to - 1);
    if (lineBreak >= from && lineBreak >= from + Math.floor((to - from) * 0.75)) to = lineBreak + 1;
  }
  const slice = buf.subarray(from, to);
  return { text: slice.toString('utf8'), offset: start + from, nextOffset: reachesEnd && to === buf.length ? null : start + to, binary: slice.includes(0) };
}
