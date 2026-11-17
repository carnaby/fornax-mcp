import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/commands/context.js';
import { pipedInputHint, VALUE_AS_ARGUMENT } from '../src/commands/secrets.js';
import type { SecretInput } from '../src/hidden-input.js';
import { readSecret } from '../src/secrets.js';
import { testPaths, useTempDir, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const V = 'hf_test_value_123';

function cli(first: SecretInput = { raw: `${V}\n` }) {
  let input = first;
  const lines: string[] = [];
  const prompts: string[] = [];
  const ctx: Ctx = {
    paths: testPaths(tmp()),
    out: (l) => lines.push(l),
    signal: new AbortController().signal,
    readSecretInput: async (prompt) => {
      prompts.push(prompt);
      return input;
    },
  };
  const run = async (...argv: string[]) => {
    lines.length = 0;
    const code = await runCli(argv, ctx);
    return { code, text: lines.join('\n') };
  };
  return { ctx, run, prompts, setInput: (i: SecretInput) => (input = i) };
}

describe('fornax secrets (spec 08 § 3)', () => {
  test('set from the input: saved, the value never printed; names the packs that want it', async () => {
    const { ctx, run, prompts } = cli();
    writeEchoPack(ctx.paths.typesDir, { name: 'wants', setup: ['{tool.node}', '-e', '0'], secrets: ['EXAMPLE_TOKEN'] });
    const r = await run('secrets', 'set', 'EXAMPLE_TOKEN');
    expect(r.code).toBe(0);
    expect(prompts).toEqual(['EXAMPLE_TOKEN: ']);
    expect(readSecret(ctx.paths.secretsDir, 'EXAMPLE_TOKEN')).toBe(V);
    expect(r.text).toBe([
      `EXAMPLE_TOKEN saved in ${join(ctx.paths.secretsDir, 'EXAMPLE_TOKEN')}`,
      'used by the setup of: wants; run fornax types setup wants to use it now',
    ].join('\n'));
    expect(r.text).not.toContain(V);
  });

  test('set with --from-file reads the file (a token file with a CRLF); no pack wants it', async () => {
    const { ctx, run, prompts } = cli();
    const file = join(tmp(), 'token');
    writeFileSync(file, `${V}\r\n`);
    const r = await run('secrets', 'set', 'OTHER_TOKEN', '--from-file', file);
    expect(r.code).toBe(0);
    expect(prompts).toEqual([]);
    expect(readSecret(ctx.paths.secretsDir, 'OTHER_TOKEN')).toBe(V);
    expect(r.text).toContain('no installed type pack asks for OTHER_TOKEN');
  });

  test('--from-file ~/… is read from the home directory, as PowerShell 5.1 passes ~ unexpanded (final review #4)', async () => {
    const { ctx, run } = cli();
    const home = tmp();
    writeFileSync(join(home, 'token'), `${V}\n`);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect((await run('secrets', 'set', 'EXAMPLE_TOKEN', '--from-file', '~/token')).code).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(readSecret(ctx.paths.secretsDir, 'EXAMPLE_TOKEN')).toBe(V);
  });

  test('the token given as the --from-file path is not echoed (final review #6)', async () => {
    const { run } = cli();
    const r = await run('secrets', 'set', 'EXAMPLE_TOKEN', '--from-file', V);
    expect(r.code).toBe(1);
    expect(r.text).toBe('the file given with --from-file cannot be read (ENOENT); nothing was saved');
  });

  test('a stdin that is not a terminal gets a hint on stderr; in Git Bash it says the input shows (final review #1)', () => {
    expect(pipedInputHint({ MSYSTEM: 'MINGW64' }, 'HF_TOKEN')).toBe(
      'this window cannot hide what you type (Git Bash); to keep HF_TOKEN off the screen use --from-file <path>, Windows Terminal or PowerShell; otherwise paste it, press Enter, then Ctrl+D',
    );
    expect(pipedInputHint({}, 'HF_TOKEN')).toBe('reading HF_TOKEN from standard input (end it with Ctrl+D)');
  });

  test('--from-file: a missing file is 1, a file over 64 KiB is 2, nothing saved', async () => {
    const { ctx, run } = cli();
    expect((await run('secrets', 'set', 'EXAMPLE_TOKEN', '--from-file', join(tmp(), 'missing'))).code).toBe(1);
    const big = join(tmp(), 'big');
    writeFileSync(big, 'x'.repeat(64 * 1024 + 1));
    const r = await run('secrets', 'set', 'EXAMPLE_TOKEN', '--from-file', big);
    expect(r.code).toBe(2);
    expect(r.text).toBe('the input is larger than 64 KiB; nothing was saved');
    expect(existsSync(ctx.paths.secretsDir)).toBe(false);
  });

  test('empty input saves nothing and keeps the old value', async () => {
    const { ctx, run, setInput } = cli();
    await run('secrets', 'set', 'EXAMPLE_TOKEN');
    setInput({ raw: '' });
    const r = await run('secrets', 'set', 'EXAMPLE_TOKEN');
    expect(r.code).toBe(2);
    expect(r.text).toBe('the value is empty; nothing was saved');
    expect(readSecret(ctx.paths.secretsDir, 'EXAMPLE_TOKEN')).toBe(V);
  });

  test('Ctrl+C is 130 and input over the limit is 2; nothing saved', async () => {
    const { ctx, run, setInput } = cli({ canceled: true });
    const canceled = await run('secrets', 'set', 'EXAMPLE_TOKEN');
    expect(canceled.code).toBe(130);
    expect(canceled.text).toBe('canceled; nothing was saved');
    setInput({ tooLong: true });
    expect((await run('secrets', 'set', 'EXAMPLE_TOKEN')).code).toBe(2);
    expect(existsSync(ctx.paths.secretsDir)).toBe(false);
  });

  test("the token in the name's place is not echoed", async () => {
    const { run } = cli();
    const r = await run('secrets', 'set', V);
    expect(r.code).toBe(2);
    expect(r.text).toBe('secret names are upper case (HF_TOKEN, not hf_token)');
  });

  test('a value given as an argument is refused without echo', async () => {
    const { ctx, run } = cli();
    for (const argv of [['secrets', 'set', 'EXAMPLE_TOKEN', V], ['secrets', 'set', 'EXAMPLE_TOKEN', `--token=${V}`]]) {
      const r = await run(...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.text).not.toContain(V);
    }
    expect(existsSync(ctx.paths.secretsDir)).toBe(false);
    // Final review #7: the plain form gets its own reason.
    expect((await run('secrets', 'set', 'EXAMPLE_TOKEN', V)).text).toBe(VALUE_AS_ARGUMENT);
  });

  test('--from-file with a UTF-16 file: 2, a reason, nothing saved (final review #5)', async () => {
    const { ctx, run } = cli();
    const file = join(tmp(), 'token-utf16');
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(V, 'utf16le')]));
    const r = await run('secrets', 'set', 'EXAMPLE_TOKEN', '--from-file', file);
    expect(r).toEqual({ code: 2, text: 'the file is UTF-16; save it as UTF-8; nothing was saved' });
    expect(existsSync(ctx.paths.secretsDir)).toBe(false);
  });

  test('list: stored ones with their packs, wanted ones not set; remove', async () => {
    const { ctx, run } = cli();
    expect((await run('secrets', 'list')).text).toBe(`no secrets in ${ctx.paths.secretsDir}`);
    writeEchoPack(ctx.paths.typesDir, { name: 'a-pack', setup: ['{tool.node}', '-e', '0'], secrets: ['EXAMPLE_TOKEN', 'OTHER_TOKEN'] });
    writeEchoPack(ctx.paths.typesDir, { name: 'b-pack', setup: ['{tool.node}', '-e', '0'], secrets: ['EXAMPLE_TOKEN'] });
    await run('secrets', 'set', 'EXAMPLE_TOKEN');
    await run('secrets', 'set', 'THIRD_TOKEN');
    expect((await run('secrets', 'list')).text).toBe([
      'EXAMPLE_TOKEN  used by: a-pack, b-pack',
      'THIRD_TOKEN  not used by any installed pack',
      'OTHER_TOKEN  not set (wanted by: a-pack)',
    ].join('\n'));
    const removed = await run('secrets', 'remove', 'EXAMPLE_TOKEN');
    expect(removed.code).toBe(0);
    expect(removed.text).toBe('EXAMPLE_TOKEN removed\nthe next setup of a-pack, b-pack runs without it');
    expect((await run('secrets', 'remove', 'EXAMPLE_TOKEN')).text).toBe('EXAMPLE_TOKEN is not set');
    expect((await run('secrets', 'remove', 'lower')).code).toBe(2);
  });

  test('the usage lists the new commands', async () => {
    const { run } = cli();
    const text = (await run('--help')).text;
    for (const l of ['fornax types setup <name>', 'fornax secrets set <NAME> [--from-file <path>]', 'fornax secrets list', 'fornax secrets remove <NAME>']) expect(text).toContain(l);
  });
});
