import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkPack, environmentOf, findBatchOnly, findTool, isBatchFile, oneLine, packsSignature, preparePacks, runCheck } from '../src/checks.js';
import { writeOrigin } from '../src/install/packs.js';
import { loadPack } from '../src/pack.js';
import { isAlive, NODE_TOOLS, readPids, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const dirsFor = (typesDir: string) => ({ secretsDir: join(tmp(), 'secrets'), typesDir });

describe('findTool', () => {
  test('an absolute path must exist; a bare name is looked up on PATH', () => {
    expect(findTool(process.execPath)).toBe(process.execPath);
    expect(findTool(join(tmp(), 'missing'))).toBeNull();
    const env = { PATH: dirname(process.execPath), PATHEXT: '.EXE' };
    expect(findTool('node', env)?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(findTool('fornax-test-no-such-tool', env)).toBeNull();
  });

  test('on Windows a batch file is never accepted: only real executables resolve', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'tool.cmd'), '');
    writeFileSync(join(dir, 'tool.bat'), '');
    writeFileSync(join(dir, 'real.exe'), '');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(findTool('tool', env, 'win32')).toBeNull();
    expect(findTool('tool.cmd', env, 'win32')).toBeNull();
    expect(findTool('real', env, 'win32')?.toLowerCase()).toBe(join(dir, 'real.exe').toLowerCase());
    expect(isBatchFile('C:\\x\\a.BAT', 'win32')).toBe(true);
    expect(isBatchFile('a.cmd', 'linux')).toBe(false);
  });

  test('on Windows only what spawn starts without a shell counts: the name as given, or with .com or .exe appended', () => {
    const dir = tmp();
    for (const f of ['tool.py', 'tool.ps1', 'other.com', 'plain', 'real.exe']) writeFileSync(join(dir, f), '');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD;.PY;.PS1' };
    // PATHEXT plays no part: spawn tries only .com and .exe.
    expect(findTool('tool', env, 'win32')).toBeNull();
    expect(findTool('tool.py', env, 'win32')).toBeNull();
    expect(findTool(join(dir, 'tool.py'), env, 'win32')).toBeNull();
    expect(findTool(join(dir, 'tool.ps1'), env, 'win32')).toBeNull();
    expect(findTool('other', env, 'win32')?.toLowerCase()).toBe(join(dir, 'other.com').toLowerCase());
    expect(findTool('real.exe', env, 'win32')?.toLowerCase()).toBe(join(dir, 'real.exe').toLowerCase());
    expect(findTool(join(dir, 'real'), env, 'win32')?.toLowerCase()).toBe(join(dir, 'real.exe').toLowerCase());
    // A file without an extension is never started as it is.
    expect(findTool('plain', env, 'win32')).toBeNull();
    expect(findTool(join(dir, 'plain'), env, 'win32')).toBeNull();
  });

  test.runIf(process.platform !== 'win32')('on Linux a tool must be executable', () => {
    const dir = tmp();
    const file = join(dir, 'tool');
    writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
    const env = { PATH: dir };
    expect(findTool(file, env, 'linux')).toBeNull();
    expect(findTool('tool', env, 'linux')).toBeNull();
    chmodSync(file, 0o755);
    expect(findTool(file, env, 'linux')).toBe(file);
    expect(findTool('tool', env, 'linux')).toBe(file);
  });

  test.runIf(process.platform === 'win32')('checkPack reports a configured batch file clearly', async () => {
    const batch = join(tmp(), 'tool.cmd');
    writeFileSync(batch, '');
    const pack = loadPack(writeEchoPack(join(tmp(), 'types')));
    expect(await checkPack(pack, { node: batch }, dirsFor(tmp()))).toBe(`tool node: ${batch} is a batch file; point worker.yaml at the real executable`);
  });
});

describe('tool paths', () => {
  test('a directory is not a tool', () => {
    const dir = join(tmp(), 'a-dir');
    mkdirSync(dir);
    expect(findTool(dir)).toBeNull();
  });

  test('a bare name that exists only as a batch file is recognised on Windows', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'npm.cmd'), '');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(findTool('npm', env, 'win32')).toBeNull();
    expect(findBatchOnly('npm', env, 'win32')).toBe(join(dir, 'npm.cmd'));
    expect(findBatchOnly('npm', env, 'linux')).toBeNull();
    expect(findBatchOnly('nothing', env, 'win32')).toBeNull();
  });
});

describe('oneLine', () => {
  test('control characters and line breaks become spaces; the length is capped', () => {
    expect(oneLine('a\r\nb\u0007\tc')).toBe('a b c');
    const long = oneLine('x'.repeat(500));
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });

  test('the cap counts characters, so an emoji is never cut in half (JSON would get a lone surrogate)', () => {
    const cut = oneLine(`${'x'.repeat(198)}🔥🔥`, 200);
    expect(cut).toBe(`${'x'.repeat(198)}🔥🔥`);
    const longer = oneLine(`${'x'.repeat(198)}🔥🔥🔥`, 200);
    expect(longer).toBe(`${'x'.repeat(198)}🔥…`);
    // encodeURIComponent throws on a lone surrogate.
    expect(() => encodeURIComponent(longer)).not.toThrow();
  });
});

describe('check isolation', () => {
  test('a failing check shows one short line of its output', async () => {
    const script = 'console.log("first\\nsecond\\u0007 " + "y".repeat(400)); process.exitCode = 4';
    const pack = loadPack(writeEchoPack(join(tmp(), 'types'), { name: 'noisy', check: ['{tool.node}', '-e', script] }));
    const reason = (await checkPack(pack, NODE_TOOLS, dirsFor(tmp())))!;
    expect(reason.startsWith('check failed (exit code 4): ')).toBe(true);
    const shown = reason.slice('check failed (exit code 4): '.length);
    expect(shown.length).toBeLessThanOrEqual(200);
    expect(shown).not.toMatch(/[\u0000-\u001f]/);
  });

  test('a hanging check is killed with everything it started', async () => {
    const pidFile = join(tmp(), 'check-pids.json');
    const dir = writeEchoPack(join(tmp(), 'types'), { name: 'tree', check: ['{tool.node}', '{pack}/check-tree.mjs', pidFile] });
    // A check that starts a grandchild ignoring SIGTERM, records both pids and hangs.
    writeFileSync(
      join(dir, 'check-tree.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const c = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
        'writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: c.pid }));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const pack = loadPack(dir);
    // Long enough for a busy CI machine to start Node twice and write the pid file before the timeout fires.
    expect(await checkPack(pack, NODE_TOOLS, dirsFor(tmp()), { timeoutMs: 4000, killGraceMs: 300 })).toBe('check did not finish within 4 s');
    const pids = await waitFor(() => readPids(pidFile), 5000, 'the check to record its pids');
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000, 'the check tree to die');
  });

  test('preparePacks starts no further check once stopped', async () => {
    const types = join(tmp(), 'types');
    writeEchoPack(types, { name: 'a' });
    writeEchoPack(types, { name: 'b' });
    const stop = new AbortController();
    stop.abort();
    expect(await preparePacks(dirsFor(types), NODE_TOOLS, { signal: stop.signal })).toEqual({ ready: [], problems: [], environments: {} });
  });
});

describe('checkPack', () => {
  test('tools first, then the check command', async () => {
    const types = join(tmp(), 'types');
    const ok = loadPack(writeEchoPack(types));
    expect(await checkPack(ok, NODE_TOOLS, dirsFor(tmp()))).toBeNull();
    expect(await checkPack(ok, {}, dirsFor(tmp()))).toBe('tools missing in worker.yaml: node');
    expect(await checkPack(ok, { node: join(tmp(), 'nothing-here') }, dirsFor(tmp()))).toMatch(/tool node: .* was not found/);
    const sick = loadPack(writeEchoPack(types, { name: 'sick', check: ['{tool.node}', '-e', 'console.log("no GPU"); process.exitCode = 3'] }));
    expect(await checkPack(sick, NODE_TOOLS, dirsFor(tmp()))).toBe('check failed (exit code 3): no GPU');
  });

  test('a check that hangs is stopped after the timeout and reported', async () => {
    const stuck = loadPack(writeEchoPack(join(tmp(), 'types'), { name: 'stuck', check: ['{tool.node}', '-e', 'setInterval(() => 0, 1000)'] }));
    const started = Date.now();
    expect(await checkPack(stuck, NODE_TOOLS, dirsFor(tmp()), { timeoutMs: 500, killGraceMs: 200 })).toBe('check did not finish within 0.5 s');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('environment (spec 12 § 2)', () => {
  test('the last fornax-environment line of stdout counts, as one short line', () => {
    const out = ['Blender 5.2.2 LTS', 'fornax-environment: first', 'fornax-environment:  Blender 5.2.2 LTS, Cycles on OPTIX (Fake GPU) ', 'Blender quit', ''].join('\n');
    expect(environmentOf(out)).toBe('Blender 5.2.2 LTS, Cycles on OPTIX (Fake GPU)');
    expect(environmentOf('no line here\n')).toBeNull();
    expect(environmentOf('fornax-environment:   \n')).toBeNull();
    expect(environmentOf('say fornax-environment: not at the start\n')).toBeNull();
    expect(environmentOf(`fornax-environment: ${'x'.repeat(300)}\n`)).toHaveLength(200);
    expect(environmentOf('  fornax-environment: tab\there\r\n')).toBe('tab here');
  });

  test('runCheck takes it from the stdout of a passing check only', async () => {
    const types = join(tmp(), 'types');
    const pack = (name: string, js: string) => loadPack(writeEchoPack(types, { name, check: ['{tool.node}', '-e', js] }));
    expect(await runCheck(pack('ok', 'console.log("fornax-environment: Node fake 1.0")'), NODE_TOOLS, dirsFor(tmp()))).toEqual({ problem: null, environment: 'Node fake 1.0' });
    expect(await runCheck(pack('stderr', 'console.error("fornax-environment: on stderr")'), NODE_TOOLS, dirsFor(tmp()))).toEqual({ problem: null, environment: null });
    const sick = await runCheck(pack('sick', 'console.log("fornax-environment: x"); process.exitCode = 3'), NODE_TOOLS, dirsFor(tmp()));
    expect(sick).toEqual({ problem: expect.stringMatching(/^check failed \(exit code 3\)/), environment: null });
    expect(await runCheck(pack('quiet', 'process.exit(0)'), NODE_TOOLS, dirsFor(tmp()))).toEqual({ problem: null, environment: null });
  });

  test('preparePacks gives the environments of the ready packs', async () => {
    const types = join(tmp(), 'types');
    writeEchoPack(types, { check: ['{tool.node}', '-e', 'console.log("fornax-environment: Node fake 1.0")'] });
    writeEchoPack(types, { name: 'plain' });
    writeEchoPack(types, { name: 'sick', check: ['{tool.node}', '-e', 'console.log("fornax-environment: x"); process.exit(1)'] });
    const r = await preparePacks(dirsFor(types), NODE_TOOLS);
    expect(r.ready.map((p) => p.contract.name)).toEqual(['echo', 'plain']);
    expect(r.environments).toEqual({ echo: 'Node fake 1.0' });
  });
});

describe('packs', () => {
  test('preparePacks splits ready packs from problems', async () => {
    const types = join(tmp(), 'types');
    writeEchoPack(types);
    writeEchoPack(types, { name: 'sick', check: ['{tool.node}', '-e', 'process.exit(1)'] });
    const r = await preparePacks(dirsFor(types), NODE_TOOLS);
    expect(r.ready.map((p) => p.contract.name)).toEqual(['echo']);
    expect(r.problems).toEqual([{ name: 'sick', reason: expect.stringMatching(/^check failed \(exit code 1\)/) }]);
  });

  test('the signature changes when a pack is added or its type.yaml changes', () => {
    const types = join(tmp(), 'types');
    const empty = packsSignature(types);
    const dir = writeEchoPack(types);
    const one = packsSignature(types);
    expect(one).not.toBe(empty);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'type.yaml'), later, later);
    expect(packsSignature(types)).not.toBe(one);
  });

  test("the signature changes when a pack's setup ends, though its type.yaml stays the same", () => {
    // fornax types install copies the pack in before its setup runs: a worker that checked it meanwhile must check it
    // again once the setup is done, or the type is never offered.
    const types = join(tmp(), 'types');
    const dir = writeEchoPack(types);
    writeOrigin(dir, 'shipped', true);
    const pending = packsSignature(types);
    writeOrigin(dir, 'shipped');
    expect(packsSignature(types)).not.toBe(pending);
  });
});

describe('the check environment (spec 08 § 4.2)', () => {
  test('a check never sees an inherited variable named like a secret', async () => {
    const types = tmp();
    const dirs = dirsFor(types);
    // No braces: every {…} in type.yaml is a symbol.
    const pack = loadPack(writeEchoPack(types, { check: ['{tool.node}', '-e', 'process.exit(process.env.EXAMPLE_TOKEN === undefined ? 0 : 7)'] }));
    process.env.EXAMPLE_TOKEN = 'inherited';
    try {
      expect(await checkPack(pack, NODE_TOOLS, dirs)).toBe('check failed (exit code 7)');
      writeEchoPack(types, { name: 'wants', setup: ['{tool.node}', '-e', '0'], secrets: ['EXAMPLE_TOKEN'] });
      expect(await checkPack(pack, NODE_TOOLS, dirs)).toBeNull();
    } finally {
      delete process.env.EXAMPLE_TOKEN;
    }
  });
});
