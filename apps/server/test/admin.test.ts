import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '@fornax/protocol';
import { expect, test } from 'vitest';
import { runAdmin } from '../src/admin.js';
import { openDb } from '../src/db/client.js';
import { listTokens, resolveToken } from '../src/domain/tokens.js';
import { useTestDb } from './helpers.js';

const t = useTestDb();
const now = new Date('2026-11-13T10:00:00Z');

function admin(...argv: string[]) {
  const lines: string[] = [];
  const code = runAdmin(argv, { db: t.db, config: t.config, now, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

test('client invite prints the pairing link', () => {
  const r = admin('tokens', 'invite', 'alice');
  expect(r.code).toBe(0);
  expect(r.text).toMatch(/https:\/\/fornax\.example\.com\/pair\/[A-Za-z0-9_-]{22}/);
});

test('worker invite prints the pair command with the name', () => {
  const r = admin('tokens', 'invite', 'pc', '--worker');
  expect(r.code).toBe(0);
  expect(r.text).toContain('fornax worker pair --server https://fornax.example.com --name pc');
  expect(r.text).not.toContain('--invite');
});

test('unknown flags and extra words are refused, and nothing is created', () => {
  expect(admin('tokens', 'invite', 'pc', '--wroker')).toMatchObject({ code: 2, text: expect.stringContaining('--wroker') });
  expect(admin('tokens', 'list', '--worker').code).toBe(2);
  expect(admin('tokens', 'pending', 'alice').code).toBe(2);
  expect(admin('tokens', 'approve', 'a', 'b').code).toBe(2);
  // The refused invite left nothing behind, so this one is not "already open".
  expect(admin('tokens', 'invite', 'pc', '--worker').code).toBe(0);
});

test('pending, approve, list, revoke', () => {
  admin('tokens', 'invite', 'alice');
  resolveToken(t.db, generateToken('alice'), now);
  expect(admin('tokens', 'pending').text).toMatch(/alice · client · [A-Z2-7]{4}-[A-Z2-7]{4}/);
  expect(admin('tokens', 'approve', 'alice').code).toBe(0);
  expect(admin('tokens', 'list').text).toMatch(/alice · client · active/);
  expect(admin('tokens', 'revoke', 'alice').code).toBe(0);
});

test('errors and usage', () => {
  expect(admin('tokens', 'approve', 'nobody')).toMatchObject({ code: 1 });
  expect(admin('tokens', 'invite', 'Bad Name').code).toBe(1);
  expect(admin('nonsense').code).toBe(2);
});

test('uninvite removes an unused invite so a new one can be made', () => {
  expect(admin('tokens', 'invite', 'alice').code).toBe(0);
  expect(admin('tokens', 'invite', 'alice').code).toBe(1);
  expect(admin('tokens', 'uninvite', 'alice')).toMatchObject({ code: 0, text: 'removed 1 unused invite(s) for alice' });
  expect(admin('tokens', 'invite', 'alice').code).toBe(0);
  expect(admin('tokens', 'uninvite').code).toBe(2);
});

test('backup writes a consistent database copy and the job files without partial uploads', () => {
  admin('tokens', 'invite', 'alice');
  resolveToken(t.db, generateToken('alice'), now);
  mkdirSync(join(t.config.filesDir, 'tmp'), { recursive: true });
  writeFileSync(join(t.config.filesDir, '01FILE0000000000000000000A'), 'content');
  writeFileSync(join(t.config.filesDir, 'tmp', '01PART000000000000000000000.part'), 'partial');
  const target = mkdtempSync(join(tmpdir(), 'fornax-backup-'));
  try {
    const r = admin('backup', join(target, 'nightly'));
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/backup written to .*nightly: database \d+ bytes, 1 file\(s\)/);
    expect(readdirSync(join(target, 'nightly', 'files'))).toEqual(['01FILE0000000000000000000A']);
    const copy = openDb(join(target, 'nightly', 'fornax.db'));
    try {
      expect(listTokens(copy.db).map((x) => x.name)).toEqual(['alice']);
    } finally {
      copy.close();
    }
    expect(admin('backup', join(target, 'nightly')).code).toBe(1);
    expect(existsSync(join(target, 'nightly', 'fornax.db'))).toBe(true);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
