#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { type Db, openDb } from './db/client.js';
import { DomainError } from './domain/errors.js';
import { approveToken, createInvite, listTokens, revokeToken } from './domain/tokens.js';

const USAGE = [
  'usage: fornax-admin tokens invite <name> [--worker]',
  '       fornax-admin tokens pending | list',
  '       fornax-admin tokens approve <name>',
  '       fornax-admin tokens revoke <name>',
].join('\n');

/** Flags each command accepts; anything else is refused, so a typo like --wroker cannot silently change the meaning. */
const FLAGS: Record<string, string[]> = { invite: ['--worker'] };
const NEEDS_NAME = ['invite', 'approve', 'revoke'];

export function runAdmin(argv: string[], deps: { db: Db; config: Config; now?: Date; out: (line: string) => void }): number {
  const { db, config, out } = deps;
  const now = deps.now ?? new Date();
  const [group, cmd, ...args] = argv;
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
