import type { FastifyReply } from 'fastify';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Bidirectional overrides and isolates can make text read differently from what it is: they are shown as visible U+XXXX markers. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c).replace(BIDI, (c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);

/** Markup that is already safe. Only html`` and the page code make it; every other value is escaped on the way in. */
export class Html {
  constructor(readonly markup: string) {}
}

function piece(v: unknown): string {
  if (v instanceof Html) return v.markup;
  if (Array.isArray(v)) return v.map(piece).join('');
  if (v === null || v === undefined || v === false) return '';
  return escapeHtml(String(v));
}

/** Tagged template for pages: interpolated values are escaped unless they are Html. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += piece(values[i]) + (strings[i + 1] ?? '');
  return new Html(out);
}

const STYLE = new Html(`
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; --error: #c62828; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --code: #151b23; --error: #ff7b72; } }
body { margin: 0 auto; max-width: 960px; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } h3 { font-size: 1rem; margin-bottom: 0.25rem; }
a { color: inherit; }
.muted { color: var(--muted); }
.error { color: var(--error); }
pre, code { background: var(--code); border: 1px solid var(--line); border-radius: 6px; font: 13px/1.45 ui-monospace, monospace; }
pre { padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; max-height: 480px; }
code { padding: 2px 6px; word-break: break-all; }
img, video { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
audio, progress { width: 100%; }
button { font: inherit; padding: 2px 10px; }
`);

/** A whole page: neutral styling for light and dark mode, no external assets. */
export function page(p: { title: string; head?: Html; body: Html }): string {
  const doc = html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${p.title}</title>${p.head ?? null}<style>${STYLE}</style></head><body>${p.body}</body></html>`;
  return `<!doctype html>\n${doc.markup}`;
}

/** Headers every page sends: its CSP, no referrer, no indexing, no sniffing. */
export function pageHeaders(reply: FastifyReply, csp: string, cacheControl: string): FastifyReply {
  return reply
    .header('content-security-policy', csp)
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex')
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', cacheControl)
    .type('text/html; charset=utf-8');
}
