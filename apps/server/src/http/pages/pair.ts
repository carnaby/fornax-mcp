import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { invites } from '../../db/schema.js';
import type { RouteDeps } from '../deps.js';
import { Html, html, page, pageHeaders } from './html.js';
import { PAIR_CRYPTO_JS, PAIR_PAGE_JS } from './pair-script.js';

export const pairCsp = (nonce: string): string =>
  `script-src 'nonce-${nonce}'; default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'`;

/** JSON inside a script element: "<" escaped, so no value can end the element. */
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

function clientPage(publicUrl: string, name: string, nonce: string): string {
  const script = `const FORNAX = ${scriptJson({ name, publicUrl })};\n${PAIR_CRYPTO_JS}\n${PAIR_PAGE_JS}\nconst fornaxDone = fornaxPairPage(document, window, FORNAX);`;
  return page({
    title: 'Fornax · connect',
    body: html`<h1>Connect to Fornax as ${name}</h1>
<noscript><p class="error">This page makes your token in the browser and needs JavaScript for that.</p></noscript>
<p id="problem" class="error" hidden></p>
<div id="ready" hidden>
<p>Your token was made in this browser and has not left it. Keep it like a password: whoever has it can use Fornax as you. Reloading this page makes a different token, so keep the one you copy.</p>
<h2>Token</h2>
<p><code id="token"></code> <button type="button" data-copy="token">Copy</button></p>
<h2>Claude Code</h2>
<p><code id="claude-code"></code> <button type="button" data-copy="claude-code">Copy</button></p>
<h2>claude.ai</h2>
<p>Add a custom connector with this URL. It contains the token: treat it as a password.</p>
<p><code id="connector"></code> <button type="button" data-copy="connector">Copy</button></p>
<h2>Fingerprint</h2>
<p><strong id="fingerprint"></strong></p>
<p>Use the token once (add it to Claude Code or claude.ai and call any Fornax tool), then send this fingerprint, not the token, to the admin. Until the admin approves it, every tool answers that the token waits for approval.</p>
</div>
<script nonce="${nonce}">${new Html(script)}</script>`,
  });
}

function workerPage(publicUrl: string, name: string): string {
  return page({
    title: 'Fornax · connect',
    body: html`<h1>Worker invite for ${name}</h1>
<p>A worker pairs from its own PC, not in the browser. Run this on the worker PC:</p>
<p><code>fornax worker pair --server ${publicUrl} --name ${name}</code></p>
<p>Then send the fingerprint it prints to the admin.</p>`,
  });
}

const INVALID = page({ title: 'Fornax', body: html`<h1>Fornax</h1><p>This invite is not valid. Ask the admin for a new one.</p>` });

/** GET /pair/<invite id>: the page that makes a client token in the browser. Says nothing about invites that are not valid. */
export const pairPageRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.get<{ Params: { invite: string } }>('/pair/:invite', async (req, reply) => {
    const nonce = randomBytes(16).toString('base64');
    pageHeaders(reply, pairCsp(nonce), 'no-store');
    const invite = deps.db
      .select()
      .from(invites)
      .where(and(eq(invites.id, req.params.invite), isNull(invites.tokenId), gt(invites.expiresAt, deps.clock())))
      .get();
    if (!invite) return reply.code(404).send(INVALID);
    if (invite.role === 'worker') return reply.send(workerPage(deps.config.publicUrl, invite.name));
    return reply.send(clientPage(deps.config.publicUrl, invite.name, nonce));
  });
};
