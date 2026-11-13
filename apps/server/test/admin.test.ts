import { generateToken } from '@fornax/protocol';
import { expect, test } from 'vitest';
import { runAdmin } from '../src/admin.js';
import { resolveToken } from '../src/domain/tokens.js';
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

test('worker invite prints the pair command', () => {
  const r = admin('tokens', 'invite', 'pc', '--worker');
  expect(r.text).toMatch(/fornax worker pair --server https:\/\/fornax\.example\.com --invite [A-Za-z0-9_-]{22}/);
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
