import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { JobTypeContract } from '@fornax/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { migrateDb } from '../src/db/client.js';
import { jobTypes, tokens } from '../src/db/schema.js';
import { SqliteDatabase } from '../src/db/sqlite.js';
import { useTestDb } from './helpers.js';

describe('SqliteDatabase (better-sqlite3 subset over node:sqlite)', () => {
  let db: SqliteDatabase;
  const count = () => (db.prepare('select count(*) as n from t').get() as { n: number }).n;

  beforeEach(() => {
    db = new SqliteDatabase(':memory:');
    db.exec('create table t (id integer primary key, v)');
  });
  afterEach(() => db.close());

  test('run reports changes and the last row id; get returns undefined without a row', () => {
    const insert = db.prepare('insert into t (v) values (?)');
    expect(insert.run('a')).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(insert.run('b')).toEqual({ changes: 1, lastInsertRowid: 2 });
    expect(db.prepare('update t set v = ?').run('c').changes).toBe(2);
    expect(db.prepare('select * from t where id = ?').get(99)).toBeUndefined();
    expect({ ...(db.prepare('select * from t where id = ?').get(1) as object) }).toEqual({ id: 1, v: 'c' });
  });

  test('binds the parameter types drizzle passes', () => {
    const insert = db.prepare('insert into t (v) values (?)');
    insert.run(true);
    insert.run(false);
    insert.run(null);
    insert.run(2.5);
    insert.run(9_007_199_254_740_993n);
    insert.run(Buffer.from('hi'));
    const rows = db.prepare('select typeof(v) as type, cast(v as text) as text from t order by id').raw().all();
    expect(rows).toEqual([
      ['integer', '1'],
      ['integer', '0'],
      ['null', null],
      ['real', '2.5'],
      ['integer', '9007199254740993'],
      ['blob', 'hi'],
    ]);
  });

  test('rejects values SQLite cannot store instead of binding them as named parameters', () => {
    const insert = db.prepare('insert into t (v) values (?)');
    expect(() => insert.run(new Date(0))).toThrow(TypeError);
    expect(() => insert.run({ v: 1 })).toThrow(TypeError);
    expect(() => insert.run(undefined)).toThrow();
    expect(count()).toBe(0);
  });

  test('raw() returns rows as arrays, keeps duplicate column names apart, and can be switched off', () => {
    const stmt = db.prepare('select 1 as x, 2 as x');
    expect(stmt.raw().get()).toEqual([1, 2]);
    expect(stmt.all()).toEqual([[1, 2]]); // sticky, as in better-sqlite3
    expect({ ...(stmt.raw(false).get() as object) }).toEqual({ x: 2 });
  });

  test('a transaction commits and returns the callback result', () => {
    const add = db.transaction((v: string) => {
      db.prepare('insert into t (v) values (?)').run(v);
      return v.toUpperCase();
    });
    expect(add('a')).toBe('A');
    expect(add.immediate('b')).toBe('B');
    expect(add.exclusive('c')).toBe('C');
    expect(add.deferred('d')).toBe('D');
    expect(count()).toBe(4);
    expect(db.inTransaction).toBe(false);
  });

  test('a transaction rolls back when the callback throws', () => {
    const fail = db.transaction(() => {
      db.prepare('insert into t (v) values (?)').run('x');
      throw new Error('boom');
    });
    expect(() => fail()).toThrow('boom');
    expect(count()).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  test('a transaction callback must not return a promise', () => {
    const tx = db.transaction(async () => {
      db.prepare('insert into t (v) values (?)').run('x');
    });
    expect(() => tx()).toThrow('cannot return a promise');
    expect(count()).toBe(0);
  });

  test('a nested transaction uses a savepoint: its rollback keeps the outer work', () => {
    const insert = (v: string) => db.prepare('insert into t (v) values (?)').run(v);
    const inner = db.transaction(() => {
      insert('inner');
      throw new Error('inner failed');
    });
    const outer = db.transaction(() => {
      insert('outer');
      expect(() => inner()).toThrow('inner failed');
      db.transaction(() => insert('inner ok'))();
      expect(db.inTransaction).toBe(true);
    });
    outer();
    expect(db.prepare('select v from t order by id').raw().all()).toEqual([['outer'], ['inner ok']]);
  });

  test('pragma returns rows, or the single value with simple', () => {
    expect(db.pragma('busy_timeout = 5000')).toEqual([{ timeout: 5000 }]);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  test('prepare refuses a string with more than one statement, like better-sqlite3', () => {
    const multi = /more than one statement/;
    expect(() => db.prepare('select 1; select 2')).toThrow(multi);
    expect(() => db.prepare("insert into t (v) values ('a');\ninsert into t (v) values ('b')")).toThrow(multi);
    expect(() => db.prepare('select 1; -- note\n/* c */ select 2')).toThrow(multi);
    expect(count()).toBe(0);
  });

  test('prepare accepts one statement followed only by separators and comments', () => {
    for (const source of [
      'select 1',
      'select 1;',
      '  -- leading\nselect 1 ;\n',
      'select 1; -- note',
      'select 1; -- note\n  /* block */ ;  \n',
      'select 1 /* unterminated',
      "select ';' as x; ",
    ]) {
      expect(() => db.prepare(source).get(), source).not.toThrow();
    }
  });
});

describe('openDb over node:sqlite', () => {
  const t = useTestDb();
  const token = (id: string) => ({ id, name: id, role: 'client' as const, hash: `h-${id}`, fingerprint: 'AAAA-AAAA', status: 'pending' as const, createdAt: new Date(1_000) });

  test('uses WAL and a 5 s busy timeout', () => {
    expect(t.db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(t.db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  test('a migration chunk with two statements fails as a whole instead of being applied in part', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fornax-migrations-'));
    try {
      mkdirSync(join(dir, 'meta'));
      const entry = { idx: 0, version: '6', when: 1_000, tag: '0000_two', breakpoints: true };
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'sqlite', entries: [entry] }));
      // One chunk (no statement-breakpoint between them) holding two statements.
      writeFileSync(join(dir, '0000_two.sql'), 'CREATE TABLE `m_one` (`a` integer);\nCREATE TABLE `m_two` (`b` integer);\n');
      let error: unknown;
      try {
        migrateDb(t.db, { migrationsFolder: dir, migrationsTable: '__test_migrations' });
      } catch (err) {
        error = err;
      }
      // drizzle wraps the driver error in a DrizzleQueryError; the adapter's error is its cause.
      expect((error as Error | undefined)?.cause).toBeInstanceOf(RangeError);
      expect(String((error as Error).cause)).toMatch(/more than one statement/);
      const tables = t.db.$client.prepare("select name from sqlite_master where name in ('m_one', 'm_two')").all();
      expect(tables).toEqual([]);
      expect(t.db.$client.prepare('select count(*) as n from __test_migrations').raw().get()).toEqual([0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('drizzle transactions commit, roll back on throw, and nest with savepoints', () => {
    t.db.transaction((tx) => {
      tx.insert(tokens).values(token('a')).run();
      expect(() =>
        tx.transaction((inner) => {
          inner.insert(tokens).values(token('b')).run();
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
      tx.transaction((inner) => inner.insert(tokens).values(token('c')).run());
    });
    expect(() =>
      t.db.transaction((tx) => {
        tx.insert(tokens).values(token('d')).run();
        throw new Error('outer failed');
      }),
    ).toThrow('outer failed');
    const ids = t.db.select({ id: tokens.id }).from(tokens).all().map((r) => r.id);
    expect(ids.sort()).toEqual(['a', 'c']);
  });

  test('drizzle maps booleans, timestamps and JSON through the adapter', () => {
    const contract = { description: 'echo', inputs: { a: 1 } } as unknown as JobTypeContract;
    const values = { name: 'echo', contract, contractHash: 'h', offered: true, lastOfferedAt: new Date(5_000) };
    t.db.insert(jobTypes).values(values).run();
    t.db.insert(jobTypes).values({ ...values, name: 'off', offered: false }).run();
    expect(t.db.select().from(jobTypes).where(eq(jobTypes.name, 'echo')).get()).toEqual(values);
    expect(t.db.select({ name: jobTypes.name }).from(jobTypes).where(eq(jobTypes.offered, false)).all()).toEqual([{ name: 'off' }]);
    const raw = t.db.$client.prepare('select offered, last_offered_at, contract from job_types where name = ?').raw().get('echo');
    expect(raw).toEqual([1, 5_000, JSON.stringify(contract)]);
  });
});

describe('the ExperimentalWarning filter', () => {
  // In a child process, so the test sees what Node really prints on stderr.
  test('hides only the SQLite experimental warning', () => {
    const module = pathToFileURL(fileURLToPath(new URL('../src/db/sqlite.ts', import.meta.url))).href;
    const sqliteWarning = 'SQLite is an experimental feature and might change at any time';
    const script = [
      `const { SqliteDatabase } = await import(${JSON.stringify(module)});`,
      // Opening a database loads node:sqlite, which warns on Node 22 (Node 24 no longer does).
      `new SqliteDatabase(':memory:').close();`,
      `process.emitWarning(${JSON.stringify(sqliteWarning)}, 'ExperimentalWarning');`,
      `process.emitWarning(${JSON.stringify(sqliteWarning)}, { type: 'ExperimentalWarning' });`,
      `process.emitWarning('Some other feature is an experimental feature', 'ExperimentalWarning');`,
      `process.emitWarning('SQLite is an experimental feature, said as a plain warning');`,
    ].join('\n');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).not.toContain('might change at any time');
    expect(child.stderr).toContain('ExperimentalWarning: Some other feature is an experimental feature');
    expect(child.stderr).toContain('Warning: SQLite is an experimental feature, said as a plain warning');
  });
});

describe('a database file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fornax-sqlite-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('is shared between connections and released on close', () => {
    const file = join(dir, 'a.db');
    const a = new SqliteDatabase(file);
    a.pragma('journal_mode = WAL');
    a.exec('create table t (v)');
    a.prepare('insert into t values (?)').run('x');
    const b = new SqliteDatabase(file);
    expect(b.prepare('select v from t').raw().all()).toEqual([['x']]);
    b.close();
    a.close();
  });
});
