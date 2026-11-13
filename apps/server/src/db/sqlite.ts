/**
 * A thin adapter that gives Node's built-in `node:sqlite` (DatabaseSync) the
 * small part of the better-sqlite3 API that drizzle's better-sqlite3 session
 * and migrator call. Node ships SQLite itself, so installing the server needs
 * no native add-on and no C++ toolchain on any platform.
 *
 * Covered: `prepare` → statement `run` / `get` / `all` / `raw`, `transaction`
 * (with the `deferred` / `immediate` / `exclusive` variants, nested calls use a
 * savepoint), `exec`, `pragma`, `inTransaction`, `close`.
 *
 * Known differences from better-sqlite3 (none matter for the current schema):
 * - BLOB columns come back as `Uint8Array`, not `Buffer`;
 * - reading an integer above 2^53 throws instead of losing precision;
 * - SQLite errors have `code: 'ERR_SQLITE_ERROR'` with the numeric `errcode`
 *   and the text `errstr`, not a `code` such as `SQLITE_CONSTRAINT_UNIQUE`.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

/** Whitespace, `;`, `-- …` line comments and `/* … *\/` comments (SQLite allows an unterminated one at the end). */
const ONLY_SEPARATORS = /^(?:\s|;|--[^\n]*|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$))*$/;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

const EXPERIMENTAL_SQLITE = /^SQLite is an experimental feature/;
let warningFilterInstalled = false;

/**
 * Loading node:sqlite prints "ExperimentalWarning: SQLite is an experimental
 * feature". Hide exactly that warning; every other warning still goes through.
 */
export function hideSqliteExperimentalWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    const option = rest[0];
    const type =
      typeof warning !== 'string' ? warning.name : typeof option === 'string' ? option : (option as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && EXPERIMENTAL_SQLITE.test(message)) return;
    emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}

function loadSqlite(): typeof import('node:sqlite') {
  hideSqliteExperimentalWarning();
  return process.getBuiltinModule('node:sqlite');
}

/**
 * better-sqlite3 rejects values SQLite cannot store; node:sqlite would read a
 * leading plain object (a Date, say) as a map of named parameters and bind the
 * rest in the wrong places. Reject such values up front; store booleans as 1/0.
 */
function bindable(params: unknown[]): SQLInputValue[] {
  return params.map((value, i) => {
    // As bigints, so they bind as INTEGER (a JS number binds as REAL), like Node 24 binds booleans.
    if (typeof value === 'boolean') return value ? 1n : 0n;
    if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
      throw new TypeError(`SQLite cannot bind parameter ${i + 1}: only numbers, strings, bigints, buffers and null are allowed`);
    }
    return value as SQLInputValue;
  });
}

export class SqliteStatement {
  readonly #stmt: StatementSync;

  constructor(stmt: StatementSync) {
    this.#stmt = stmt;
  }

  /** Like better-sqlite3: switches this statement to rows as arrays (sticky) and returns it. */
  raw(toggle = true): this {
    this.#stmt.setReturnArrays(toggle);
    return this;
  }

  run(...params: unknown[]): SqliteRunResult {
    return this.#stmt.run(...bindable(params));
  }

  get(...params: unknown[]): unknown {
    return this.#stmt.get(...bindable(params));
  }

  all(...params: unknown[]): unknown[] {
    return this.#stmt.all(...bindable(params));
  }
}

type TxBody<A extends unknown[], R> = (...args: A) => R;
export type SqliteTransaction<A extends unknown[], R> = TxBody<A, R> & {
  deferred: TxBody<A, R>;
  immediate: TxBody<A, R>;
  exclusive: TxBody<A, R>;
};

export class SqliteDatabase {
  readonly #db: DatabaseSync;
  #savepoints = 0;

  constructor(file: string) {
    const { DatabaseSync } = loadSqlite();
    this.#db = new DatabaseSync(file);
  }

  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  /**
   * node:sqlite prepares only the first statement of the string and silently
   * drops the rest; better-sqlite3 throws. Throw too, so a migration chunk with
   * two statements cannot be applied in part and still be recorded as done.
   */
  prepare(source: string): SqliteStatement {
    const stmt = this.#db.prepare(source);
    // sourceSQL is the prepared first statement, a prefix of `source`.
    const rest = source.startsWith(stmt.sourceSQL) ? source.slice(stmt.sourceSQL.length) : source;
    if (!ONLY_SEPARATORS.test(rest)) throw new RangeError('The supplied SQL string contains more than one statement');
    return new SqliteStatement(stmt);
  }

  exec(source: string): this {
    this.#db.exec(source);
    return this;
  }

  /** `pragma('journal_mode = WAL')`; with `simple` returns the first column of the first row. */
  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const stmt = this.#db.prepare(`PRAGMA ${source}`);
    if (!options.simple) return stmt.all();
    stmt.setReturnArrays(true);
    return (stmt.get() as unknown[] | undefined)?.[0];
  }

  /**
   * Like better-sqlite3's `db.transaction(fn)`: the returned function runs `fn`
   * inside BEGIN … COMMIT and rolls back when it throws. Called while a
   * transaction is already open, it uses a savepoint instead.
   */
  transaction<A extends unknown[], R>(fn: TxBody<A, R>): SqliteTransaction<A, R> {
    const variant =
      (begin: string): TxBody<A, R> =>
      (...args) =>
        this.#db.isTransaction ? this.#nested(fn, args) : this.#outer(begin, fn, args);
    const deferred = variant('BEGIN DEFERRED');
    return Object.assign((...args: A) => deferred(...args), {
      deferred,
      immediate: variant('BEGIN IMMEDIATE'),
      exclusive: variant('BEGIN EXCLUSIVE'),
    });
  }

  close(): void {
    this.#db.close();
  }

  #outer<A extends unknown[], R>(begin: string, fn: TxBody<A, R>, args: A): R {
    this.#db.exec(begin);
    try {
      const result = synchronous(fn(...args));
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      // SQLite may already have rolled back on its own (some errors end the transaction).
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  #nested<A extends unknown[], R>(fn: TxBody<A, R>, args: A): R {
    const name = `"fornax_sp_${++this.#savepoints}"`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const result = synchronous(fn(...args));
      this.#db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      if (this.#db.isTransaction) this.#db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    } finally {
      this.#savepoints--;
    }
  }
}

function synchronous<R>(result: R): R {
  if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
    throw new TypeError('Transaction function cannot return a promise');
  }
  return result;
}
