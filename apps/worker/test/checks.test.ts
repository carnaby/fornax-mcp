import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkPack, findBatchOnly, findTool, isBatchFile, oneLine, packsSignature, preparePacks } from '../src/checks.js';
import { loadPack } from '../src/pack.js';
import { isAlive, NODE_TOOLS, readPids, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();

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
    expect(await checkPack(pack, { node: batch })).toBe(`tool node: ${batch} is a batch file; point worker.yaml at the real executable`);
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
});

describe('check isolation', () => {
  test('a failing check shows one short line of its output', async () => {
    const script = 'console.log("first\\nsecond\\u0007 " + "y".repeat(400)); process.exitCode = 4';
    const pack = loadPack(writeEchoPack(join(tmp(), 'types'), { name: 'noisy', check: ['{tool.node}', '-e', script] }));
    const reason = (await checkPack(pack, NODE_TOOLS))!;
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
    expect(await checkPack(pack, NODE_TOOLS, { timeoutMs: 4000, killGraceMs: 300 })).toBe('check did not finish within 4 s');
    const pids = await waitFor(() => readPids(pidFile), 5000, 'the check to record its pids');
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000, 'the check tree to die');
  });

  test('preparePacks starts no further check once stopped', async () => {
    const types = join(tmp(), 'types');
    writeEchoPack(types, { name: 'a' });
    writeEchoPack(types, { name: 'b' });
    const stop = new AbortController();
    stop.abort();
    expect(await preparePacks(types, NODE_TOOLS, { signal: stop.signal })).toEqual({ ready: [], problems: [] });
  });
});

describe('checkPack', () => {
  test('tools first, then the check command', async () => {
    const types = join(tmp(), 'types');
    const ok = loadPack(writeEchoPack(types));
    expect(await checkPack(ok, NODE_TOOLS)).toBeNull();
    expect(await checkPack(ok, {})).toBe('tools missing in worker.yaml: node');
    expect(await checkPack(ok, { node: join(tmp(), 'nothing-here') })).toMatch(/tool node: .* was not found/);
    const sick = loadPack(writeEchoPack(types, { name: 'sick', check: ['{tool.node}', '-e', 'console.log("no GPU"); process.exitCode = 3'] }));
    expect(await checkPack(sick, NODE_TOOLS)).toBe('check failed (exit code 3): no GPU');
  });

  test('a check that hangs is stopped after the timeout and reported', async () => {
    const stuck = loadPack(writeEchoPack(join(tmp(), 'types'), { name: 'stuck', check: ['{tool.node}', '-e', 'setInterval(() => 0, 1000)'] }));
    const started = Date.now();
    expect(await checkPack(stuck, NODE_TOOLS, { timeoutMs: 500, killGraceMs: 200 })).toBe('check did not finish within 0.5 s');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('packs', () => {
  test('preparePacks splits ready packs from problems', async () => {
    const types = join(tmp(), 'types');
    writeEchoPack(types);
    writeEchoPack(types, { name: 'sick', check: ['{tool.node}', '-e', 'process.exit(1)'] });
    const r = await preparePacks(types, NODE_TOOLS);
    expect(r.ready.map((p) => p.contract.name)).toEqual(['echo']);
    expect(r.problems).toEqual([expect.stringMatching(/^type pack sick: check failed \(exit code 1\)/)]);
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
});
