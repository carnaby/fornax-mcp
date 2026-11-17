import { parseArgs } from 'node:util';
import { AGENT_RULE, agentProblem, type Priority, priorityInput } from '@fornax/protocol';
import { ClientApi } from '../client-api.js';
import { ConfigError, readClientToken, readWorkerConfig } from '../config.js';
import { defaultLabel, labelProblem } from '../lease/program.js';
import { LEASE_EXIT, runLease } from '../lease/run.js';
import type { Ctx } from './context.js';
import { leaseToken } from './lease-token.js';

/** The forms of `fornax lease`: the one source of its lines in its own usage and in the CLI's. */
export const LEASE_FORMS = [
  'fornax lease [--minutes N] [--wait-minutes N] [--rerun] [--priority high|normal|idle] [--label TEXT] [--agent NAME] -- <program> [args…]',
  'fornax lease token        (reads a client token from standard input)',
] as const;

/** A usage text: the first form after "usage: ", the others aligned under it. */
export const usageText = (forms: readonly string[]): string => forms.map((f, i) => `${i === 0 ? 'usage: ' : '       '}${f}`).join('\n');

export const LEASE_USAGE = usageText(LEASE_FORMS);

/** A whole number from `min` to `max` (`fallback` when absent), or why not. */
function whole(raw: string | undefined, fallback: number | null, min: number, max: number, name: string): number | null | string {
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,7}$/.test(raw) || Number(raw) < min || Number(raw) > max) return `${name} must be a whole number from ${min} to ${max}`;
  return Number(raw);
}

/** Spec 09 § 2.3: --agent, else FORNAX_AGENT, else none; a blank value is none; a bad one names its source. */
export function agentOf(flag: string | undefined, env: NodeJS.ProcessEnv): { agent: string | null } | { problem: string } {
  // An environment value is trimmed: `set FORNAX_AGENT=agent-a ` in cmd.exe keeps the trailing space (final review #3).
  const [source, raw] = flag !== undefined ? ['--agent', flag] : ['FORNAX_AGENT', (env.FORNAX_AGENT ?? '').trim()];
  if (raw.trim() === '') return { agent: null };
  return agentProblem(raw) ? { problem: `${source} ${AGENT_RULE}` } : { agent: raw };
}

/**
 * `fornax lease …` (spec 05a 4.4). Everything after `--` is the program and its arguments, untouched. Its own exit
 * codes: 120 usage (anywhere under fornax lease), 121 no lease (also no client token or no worker.yaml), 122, 123 and
 * 130 from runLease; `fornax lease token` ends with 0 or 1, `--help` (before `--`) with 0.
 */
export async function leaseCommand(argv: string[], ctx: Ctx): Promise<number> {
  const err = ctx.err ?? ctx.out;
  const usage = (why: string): number => {
    err(`fornax lease: ${why}`);
    err(LEASE_USAGE);
    return LEASE_EXIT.usage;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        minutes: { type: 'string' },
        'wait-minutes': { type: 'string' },
        rerun: { type: 'boolean' },
        priority: { type: 'string' },
        label: { type: 'string' },
        agent: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    return usage((e as Error).message);
  }
  if (parsed.values.help) {
    ctx.out(LEASE_USAGE);
    return 0;
  }
  const end = parsed.tokens.find((tk) => tk.kind === 'option-terminator');
  const before = parsed.tokens.flatMap((tk) => (tk.kind === 'positional' && (end === undefined || tk.index < end.index) ? [tk.value] : []));
  if (end === undefined) {
    if (before.length === 1 && before[0] === 'token' && Object.keys(parsed.values).length === 0) return await leaseToken(ctx);
    return usage(before[0] === 'token' ? 'fornax lease token takes no arguments' : 'put -- before the program');
  }
  if (before.length) return usage(`unexpected ${before[0]} before --`);
  const [program, ...args] = argv.slice(end.index + 1);
  if (!program) return usage('no program after --');
  const v = parsed.values;
  const minutes = whole(v.minutes, 60, 1, 720, '--minutes');
  if (typeof minutes === 'string') return usage(minutes);
  const waitMinutes = whole(v['wait-minutes'], null, 1, 1_000_000, '--wait-minutes');
  if (typeof waitMinutes === 'string') return usage(waitMinutes);
  // Spec 07 § 4.3: without --priority the type's default; low is taken as normal.
  let priority: Priority | undefined;
  if (v.priority !== undefined) {
    const p = priorityInput.safeParse(v.priority);
    if (!p.success) return usage('--priority must be high, normal or idle');
    priority = p.data;
  }
  if (v.label !== undefined) {
    const problem = labelProblem(v.label);
    if (problem) return usage(problem);
  }
  const label = v.label !== undefined ? v.label || null : defaultLabel(program);
  const env = ctx.env ?? process.env;
  const agent = agentOf(v.agent, env);
  if ('problem' in agent) return usage(agent.problem);

  let server: string;
  let token: string | null;
  try {
    server = readWorkerConfig(ctx.paths).server;
    token = readClientToken(ctx.paths, env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(`fornax lease: ${e.message}`);
    return LEASE_EXIT.noLease;
  }
  if (!token) {
    err('fornax lease: no client token: store one with fornax lease token (or set FORNAX_CLIENT_TOKEN)');
    return LEASE_EXIT.noLease;
  }
  return runLease(
    { minutes: minutes ?? 60, waitMinutes, rerun: v.rerun === true, priority, label, agent: agent.agent, program, args },
    { api: new ClientApi({ server, token }), leasesDir: ctx.paths.leasesDir, say: err, signal: ctx.signal, env, cwd: process.cwd(), timings: ctx.leaseTimings },
  );
}
