import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';

export type Block = { type: string; text?: string; data?: string; mimeType?: string };
export type CallResult = { isError: boolean; blocks: Block[]; text: string };

export const bearerHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

/** MCP clients of a test app over real HTTP on 127.0.0.1 (the app starts listening on first use); closed after each test. */
export function useMcp(app: () => FastifyInstance) {
  const clients: Client[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
  });
  const base = async (): Promise<string> => {
    const a = app();
    if (!a.server.listening) await a.listen({ port: 0, host: '127.0.0.1' });
    return `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;
  };
  return {
    base,
    async connect(path: string, headers: Record<string, string> = {}): Promise<Client> {
      const client = new Client({ name: 'fornax-test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${await base()}${path}`), { requestInit: { headers } }));
      clients.push(client);
      return client;
    },
  };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const r = await client.callTool({ name, arguments: args });
  const blocks = r.content as Block[];
  return { isError: r.isError === true, blocks, text: blocks[0]?.text ?? '' };
}

/** The JSON a tool answered with; throws the tool's error text when it failed. */
export async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await callTool(client, name, args);
  if (r.isError) throw new Error(r.text);
  return JSON.parse(r.text);
}
