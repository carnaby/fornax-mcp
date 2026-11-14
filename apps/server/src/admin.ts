#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { type Db, openDb } from './db/client.js';
import { DomainError } from './domain/errors.js';
import { approveToken, createInvite, deleteInvites, listTokens, revokeToken } from './domain/tokens.js';

const USAGE = [
  'usage: fornax-admin tokens invite <name> [--worker]',
  '       fornax-admin tokens pending | list',
  '       fornax-admin tokens approve <name>',
  '       fornax-admin tokens revoke <name>',
  '       fornax-admin tokens uninvite <name>',
  '       fornax-admin backup <dir>',
].join('\n');

/** Flags each command accepts; anything else is refused, so a typo like --wroker cannot silently change the meaning. */
const FLAGS: Record<string, string[]> = { invite: ['--worker'] };
const NEEDS_NAME = ['invite', 'approve', 'revoke', 'uninvite'];

class AdminError extends Error {}

/**
 * `fornax-admin backup <dir>`: a consistent copy of the database (VACUUM INTO, safe while the server runs) and the
 * job files without partial uploads. Files written after the database copy are harmless extras; a row whose file is
 * missing answers 404 on download.
 */
function backup(db: Db, config: Config, target: string): { dir: string; dbBytes: number; files: number } {
  const dir = resolve(target);
  const inFiles = relative(resolve(config.filesDir), dir);
  const outside = inFiles === '..' || inFiles.startsWith(`..${sep}`) || isAbsolute(inFiles);
  if (!outside) {
    throw new AdminError(`${dir} is inside the files directory, which the backup copies; choose a directory outside ${config.filesDir}`);
  }
  // File-system and SQLite errors become one line for the operator (exit 1), not a stack trace.
  const step = <T>(run: () => T): T => {
    try {
      return run();
    } catch (e) {
      throw new AdminError(`the backup to ${dir} failed: ${(e as Error).message}`);
    }
  };
  if (step(() => existsSync(dir) && readdirSync(dir).length > 0)) throw new AdminError(`${dir} is not empty; choose a new or empty directory`);
  step(() => mkdirSync(dir, { recursive: true }));
  const dbFile = join(dir, 'fornax.db');
  step(() => db.$client.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`));
  let files = 0;
  if (existsSync(config.filesDir)) {
    step(() =>
      cpSync(config.filesDir, join(dir, 'files'), {
        recursive: true,
        filter: (src) => {
          const rel = relative(config.filesDir, src);
          if (rel.split(sep)[0] === 'tmp') return false;
          if (rel !== '' && statSync(src).isFile()) files++;
          return true;
        },
      }),
    );
  }
  return { dir, dbBytes: step(() => statSync(dbFile).size), files };
}

export function runAdmin(argv: string[], deps: { db: Db; config: Config; now?: Date; out: (line: string) => void }): number {
  const { db, config, out } = deps;
  const now = deps.now ?? new Date();
  const [group, cmd, ...args] = argv;
  if (group === 'backup') {
    if (cmd === undefined || argv.length !== 2 || cmd.startsWith('-')) {
      out(USAGE);
      return 2;
    }
    try {
      const r = backup(db, config, cmd);
      out(`backup written to ${r.dir}: database ${r.dbBytes} bytes, ${r.files} file(s)`);
      return 0;
    } catch (e) {
      if (e instanceof AdminError) {
        out(e.message);
        return 1;
      }
      throw e;
    }
  }
  const flags = args.filter((a) => a.startsWith('-'));
  const words = args.filter((a) => !a.startsWith('-'));
  const allowed = cmd !== undefined && Object.hasOwn(FLAGS, cmd) ? FLAGS[cmd]! : [];
  const unexpected = flags.find((f) => !allowed.includes(f)) ?? words[NEEDS_NAME.includes(cmd ?? '') ? 1 : 0];
  if (group !== 'tokens' || unexpected !== undefined) {
    if (unexpected !== undefined) out(`unexpected argument: ${unexpected}`);
    out(USAGE);
    return 2;
  }
  const name = words[0];
  try {
    switch (cmd) {
      case 'invite': {
        if (!name) break;
        const worker = flags.includes('--worker');
        const inv = createInvite(db, { name, role: worker ? 'worker' : 'client' }, now);
        const until = inv.expiresAt.toISOString();
        if (worker) {
          // The worker registers by name: its first call with a token named <name> takes this invite.
          out(`Run on the worker PC (the invite is valid until ${until}):`);
          out(`  fornax worker pair --server ${config.publicUrl} --name ${name}`);
        } else {
          out(`Send this link to ${name} (valid until ${until}):`);
          out(`  ${config.publicUrl}/pair/${inv.id}`);
        }
        out(`Then compare the fingerprint and run: fornax-admin tokens approve ${name}`);
        return 0;
      }
      case 'pending':
      case 'list': {
        const rows = listTokens(db).filter((r) => cmd === 'list' || r.status === 'pending');
        if (!rows.length) out('no tokens');
        for (const r of rows) {
          const seen = r.lastSeenAt ? `last seen ${r.lastSeenAt.toISOString()}` : 'never seen';
          out(
            cmd === 'pending'
              ? `${r.name} · ${r.role} · ${r.fingerprint} · since ${r.createdAt.toISOString()}`
              : `${r.name} · ${r.role} · ${r.status} · ${r.fingerprint} · ${seen}`,
          );
        }
        return 0;
      }
      case 'approve': {
        if (!name) break;
        const r = approveToken(db, name, now);
        out(`approved ${r.name} (${r.role}, ${r.fingerprint})`);
        return 0;
      }
      case 'uninvite': {
        if (!name) break;
        out(`removed ${deleteInvites(db, name)} unused invite(s) for ${name}`);
        return 0;
      }
      case 'revoke': {
        if (!name) break;
        out(`revoked ${revokeToken(db, name)} token(s) named ${name}`);
        return 0;
      }
    }
    out(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof DomainError) {
      out(e.message);
      return 1;
    }
    throw e;
  }
}

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const config = loadConfig();
  const { db, close } = openDb(config.dbFile);
  const code = runAdmin(process.argv.slice(2), { db, config, out: (l) => console.log(l) });
  close();
  process.exit(code);
}
