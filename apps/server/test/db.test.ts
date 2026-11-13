import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { tokens } from '../src/db/schema.js';
import { useTestDb } from './helpers.js';

const t = useTestDb();

test('migrations create the tables', () => {
  const now = new Date(1_000);
  t.db.insert(tokens).values({ id: 'a', name: 'alice', role: 'client', hash: 'h', fingerprint: 'AAAA-AAAA', status: 'pending', createdAt: now }).run();
  const row = t.db.select().from(tokens).where(eq(tokens.id, 'a')).get();
  expect(row?.createdAt.getTime()).toBe(1_000);
  expect(row?.status).toBe('pending');
});
