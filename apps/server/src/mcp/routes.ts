import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveToken } from '../domain/tokens.js';
import { bearerOf } from '../http/auth.js';
import type { RouteDeps } from '../http/deps.js';
import { buildMcpServer, type McpCaller } from './server.js';

declare module 'fastify' {
  interface FastifyRequest {
    mcpCaller?: McpCaller;
  }
}

const METHOD_NOT_ALLOWED = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null };

/** Who a raw token is on MCP: an approved client, a client waiting for approval, or nobody (unknown, revoked, a worker). */
function callerOf(deps: RouteDeps, raw: string | null): McpCaller | null {
  const r = raw ? resolveToken(deps.db, raw, deps.clock()) : null;
  if (!r) return null;
  if (r.kind === 'pending') return r;
  return r.identity.role === 'client' ? { kind: 'active', identity: r.identity } : null;
}

/**
 * /mcp (token in the Authorization header) and /mcp/<token> (for clients that cannot send headers, e.g. a claude.ai
 * connector). Stateless: a new server and transport per request. The token is checked before the body is read.
 */
export const mcpRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const server = buildMcpServer({ deps, caller: req.mcpCaller!, log: req.log });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post(
    '/mcp',
    {
      onRequest: async (req, reply) => {
        const caller = callerOf(deps, bearerOf(req));
        if (!caller) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
        req.mcpCaller = caller;
      },
    },
    (req, reply) => handle(req, reply),
  );

  app.post<{ Params: { token: string } }>(
    '/mcp/:token',
    {
      onRequest: async (req, reply) => {
        const caller = callerOf(deps, req.params.token);
        // The path is the token: answer like an unknown route, never echo it.
        if (!caller) return reply.code(404).send({ error: 'not_found', message: 'not found' });
        req.mcpCaller = caller;
      },
    },
    (req, reply) => handle(req, reply),
  );

  // Stateless: no stream to open, no session to delete. Answered here, so the URL never reaches the 404 handler.
  for (const url of ['/mcp', '/mcp/:token']) {
    app.route({ method: ['GET', 'DELETE'], url, handler: (_req, reply) => reply.code(405).send(METHOD_NOT_ALLOWED) });
  }
};
