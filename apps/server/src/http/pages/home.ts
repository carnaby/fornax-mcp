import type { FastifyPluginAsync } from 'fastify';
import type { RouteDeps } from '../deps.js';
import { pageHeaders } from './html.js';

/** The home page has no script, link or file of its own: only its inline style. */
export const HOME_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** GET /: the name and the subtitle over the logo (the tray's three stacked jobs), in the tray's dark look. Nothing more. */
const HOME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fornax</title>
<style>
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; overflow: hidden; background: #1a1918; color: #edeae6; font-family: system-ui, 'Segoe UI', sans-serif; }
svg { position: fixed; top: 50%; left: 50%; width: min(80vmin, 640px); height: auto; opacity: 0.12; transform: translate(-50%, -50%); }
main { position: relative; padding: 24px; text-align: center; }
h1 { margin: 0; font-size: clamp(48px, 12vw, 104px); font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
p { margin: 16px 0 0; color: #a8a29c; font-size: clamp(18px, 3.4vw, 28px); }
</style></head>
<body>
<svg viewBox="0 0 32 32" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><g fill="#e8622c"><rect x="3" y="4" width="26" height="7" rx="2.5"/><rect x="3" y="13" width="26" height="7" rx="2.5" opacity="0.75"/><rect x="3" y="22" width="26" height="7" rx="2.5" opacity="0.5"/></g></svg>
<main><h1>Fornax</h1><p>One GPU, many agents.</p></main>
</body></html>
`;

export const homePageRoutes: FastifyPluginAsync<RouteDeps> = async (app) => {
  app.get('/', async (_req, reply) => {
    pageHeaders(reply, HOME_CSP, 'public, max-age=3600');
    return reply.send(HOME);
  });
};
