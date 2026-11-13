import { McpServer } from '@modelcontextprotocol/server';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { createUploadLink, uploadLinkView } from '../domain/files.js';
import { cancelJob, getOwnJob, GROUP, JOB_STATES, jobView, listJobs, PRIORITIES, queuePosition, submitJob } from '../domain/jobs.js';
import { offeredTypes, typeView } from '../domain/job-types.js';
import { queueStatus } from '../domain/maintenance.js';
import type { Identity } from '../domain/tokens.js';
import { workerOnline } from '../domain/worker-state.js';
import type { RouteDeps } from '../http/deps.js';
import { resultUrl } from '../http/links.js';
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS as D } from './text.js';

export const MCP_SERVER_VERSION = '0.1.0';
/** Caps the elements one tools/call may carry (GHSA-46jr-4wx8-v453: validating a huge argument list can exhaust memory). */
const MAX_TOOL_INPUT_ELEMENTS = 10_000;

export type McpCaller = { kind: 'active'; identity: Identity } | { kind: 'pending'; fingerprint: string };
export type McpContext = { deps: RouteDeps; caller: McpCaller; log: Pick<FastifyBaseLogger, 'error'> };
export type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: Block[]; isError?: boolean };

const text = (t: string): Block => ({ type: 'text', text: t });

/**
 * One tool call for an approved client. A pending token gets the fingerprint message and nothing else. Domain errors
 * become tool errors with their status; anything else is logged (message and stack) and answered without details.
 */
export async function runBlocks(ctx: McpContext, fn: (me: Identity) => Block[] | Promise<Block[]>): Promise<ToolResult> {
  const caller = ctx.caller;
  if (caller.kind === 'pending') return { content: [text(`this token is waiting for approval; fingerprint ${caller.fingerprint}`)], isError: true };
  try {
    return { content: await fn(caller.identity) };
  } catch (e) {
    if (e instanceof DomainError) return { content: [text(`${e.status}: ${e.message}`)], isError: true };
    ctx.log.error({ err: { message: (e as Error).message, stack: (e as Error).stack } }, 'mcp tool failed');
    return { content: [text('500: internal error in Fornax; try again later')], isError: true };
  }
}

/** Like runBlocks, for tools that answer with one compact JSON text block. */
export const runJson = (ctx: McpContext, fn: (me: Identity) => unknown): Promise<ToolResult> =>
  runBlocks(ctx, async (me) => [text(JSON.stringify(await fn(me)))]);

export function buildMcpServer(ctx: McpContext): McpServer {
  const { deps } = ctx;
  const { db } = deps;
  const server = new McpServer(
    { name: 'fornax', version: MCP_SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS, maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );
  const jobId = z.string().min(1).max(40).describe('The job_id from submit_job or list_jobs.');

  server.registerTool('list_job_types', { description: D.list_job_types, inputSchema: z.object({}) }, () =>
    runJson(ctx, () => ({ types: offeredTypes(db).map(typeView), worker: workerOnline(db, deps.clock()) })),
  );

  server.registerTool(
    'create_upload',
    {
      description: D.create_upload,
      inputSchema: z.object({
        name: z.string().min(1).max(500).describe('The file name with its extension, e.g. "scene.blend"; the job type decides which extensions an input accepts.'),
      }),
    },
    ({ name }) => runJson(ctx, (me) => uploadLinkView(createUploadLink(deps, me.tokenId, name))),
  );

  server.registerTool(
    'submit_job',
    {
      description: D.submit_job,
      inputSchema: z.object({
        type: z.string().min(1).max(40).describe('A type name from list_job_types.'),
        params: z.record(z.string(), z.unknown()).default({}).describe("Parameters as the type's schema describes them."),
        inputs: z.record(z.string(), z.string().min(1).max(40)).default({}).describe('Input name to file_id from create_upload, after the upload finished.'),
        priority: z.enum(PRIORITIES).default('normal'),
        group: z.string().regex(GROUP).optional().describe('A label for related jobs (e.g. one per animation), to find them with list_jobs.'),
        callback_url: z.string().max(2000).optional().describe('Gets a signed POST when the job finishes; only URLs under a prefix the server allows.'),
      }),
    },
    (a) =>
      runJson(ctx, (me) => {
        const row = submitJob(
          db, deps.config, me.tokenId,
          { type: a.type, params: a.params, inputs: a.inputs, priority: a.priority, group: a.group ?? null, callback_url: a.callback_url ?? null },
          deps.clock(),
        );
        return { job_id: row.id, state: row.state, position: queuePosition(db, row) };
      }),
  );

  server.registerTool('get_job', { description: D.get_job, inputSchema: z.object({ job_id: jobId }) }, ({ job_id }) =>
    runJson(ctx, (me) => {
      const row = getOwnJob(db, me.tokenId, job_id);
      return { ...jobView(db, row), result_url: resultUrl(deps, row) };
    }),
  );

  server.registerTool(
    'list_jobs',
    {
      description: D.list_jobs,
      inputSchema: z.object({
        state: z.enum(JOB_STATES).optional(),
        group: z.string().regex(GROUP).optional(),
        limit: z.number().int().min(1).max(200).default(20),
      }),
    },
    (a) => runJson(ctx, (me) => ({ jobs: listJobs(db, me.tokenId, a).map((r) => jobView(db, r)) })),
  );

  server.registerTool('cancel_job', { description: D.cancel_job, inputSchema: z.object({ job_id: jobId }) }, ({ job_id }) =>
    runJson(ctx, (me) => {
      const row = cancelJob(db, me.tokenId, job_id, deps.clock());
      return { job_id: row.id, state: row.state };
    }),
  );

  server.registerTool('queue_status', { description: D.queue_status, inputSchema: z.object({}) }, () =>
    runJson(ctx, (me) => queueStatus(db, deps.clock(), me.tokenId)),
  );

  return server;
}
