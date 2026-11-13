import { utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkPack, findTool, isBatchFile, packsSignature, preparePacks } from '../src/checks.js';
import { loadPack } from '../src/pack.js';
import { NODE_TOOLS, useTempDir, writeEchoPack } from './helpers.js';

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

  test.runIf(process.platform === 'win32')('checkPack reports a configured batch file clearly', async () => {
    const batch = join(tmp(), 'tool.cmd');
    writeFileSync(batch, '');
    const pack = loadPack(writeEchoPack(join(tmp(), 'types')));
    expect(await checkPack(pack, { node: batch })).toBe(`tool node: ${batch} is a batch file; point worker.yaml at the real executable`);
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
