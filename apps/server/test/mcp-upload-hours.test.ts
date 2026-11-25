import { expect, test } from 'vitest';
import { createUploadDescription } from '../src/mcp/text.js';
import { issueToken, useTestApp } from './helpers.js';
import { bearerHeader, useMcp } from './mcp-helpers.js';

const t = useTestApp({ retention: { finishedMs: 14 * 86_400_000, orphanUploadMs: 6 * 3_600_000, unavailableTypeMs: 7 * 86_400_000, pendingTokenMs: 7 * 86_400_000 } });
const mcp = useMcp(() => t.app);

test("create_upload states the server's own lifetime of an unused upload (spec 13 § 3)", async () => {
  const client = await mcp.connect('/mcp', bearerHeader(issueToken(t.db, 'alice')));
  const { tools } = await client.listTools();
  expect(tools.find((x) => x.name === 'create_upload')!.description).toContain('A file that no job uses is deleted after 6 hours.');
});

test('one hour is singular', () => {
  expect(createUploadDescription(3_600_000)).toMatch(/deleted after 1 hour\.$/);
});
