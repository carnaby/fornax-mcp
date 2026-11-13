import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { generateToken } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { ConfigError, readToken, readWorkerConfig, saveServer, saveToken } from '../src/config.js';
import { testPaths, useTempDir } from './helpers.js';

const tmp = useTempDir();

function paths(yaml?: string) {
  const p = testPaths(tmp());
  if (yaml !== undefined) {
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.configFile, yaml);
  }
  return p;
}

describe('worker.yaml', () => {
  test('server and tools', () => {
    const p = paths('server: https://fornax.example.com/\ntools:\n  blender: /opt/blender/blender\n  python: python\n');
    expect(readWorkerConfig(p)).toEqual({ server: 'https://fornax.example.com', tools: { blender: '/opt/blender/blender', python: 'python' } });
  });

  test('tools may be empty', () => {
    expect(readWorkerConfig(paths('server: https://fornax.example.com\ntools:\n')).tools).toEqual({});
  });

  test('a missing file says how to pair', () => {
    expect(() => readWorkerConfig(paths())).toThrow(/fornax worker pair/);
  });

  test('unknown keys, bad URLs, bad tool names and broken YAML are refused', () => {
    for (const bad of [
      'servr: https://fornax.example.com\n',
      'server: ftp://fornax.example.com\n',
      'server: https://fornax.example.com\ntools:\n  Bad-Name: x\n',
      'server: [\n',
    ]) {
      expect(() => readWorkerConfig(paths(bad)), bad).toThrow(ConfigError);
    }
  });

  test('saveServer keeps the tools and the comments', () => {
    const p = paths('# tools on this PC\nserver: https://old.example.com\ntools:\n  blender: /opt/blender/blender\n');
    saveServer(p, 'https://fornax.example.com');
    expect(readFileSync(p.configFile, 'utf8')).toContain('# tools on this PC');
    expect(readWorkerConfig(p)).toEqual({ server: 'https://fornax.example.com', tools: { blender: '/opt/blender/blender' } });
  });

  test('saveServer creates the file and its directory', () => {
    const p = paths();
    saveServer(p, 'https://fornax.example.com');
    expect(readWorkerConfig(p)).toEqual({ server: 'https://fornax.example.com', tools: {} });
  });
});

describe('token file', () => {
  test('round trip; none before pairing', () => {
    const p = paths();
    expect(readToken(p)).toBeNull();
    const token = generateToken('pc');
    saveToken(p, token);
    expect(readToken(p)).toBe(token);
  });

  test('a damaged token file is an error that does not echo its content', () => {
    const p = paths();
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.tokenFile, 'garbage-value');
    expect(() => readToken(p)).toThrow(ConfigError);
    expect(() => readToken(p)).not.toThrow(/garbage-value/);
  });

  test('the token file is readable by its owner only (0600), also when it existed before', () => {
    const p = paths();
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.tokenFile, 'old', { mode: 0o644 });
    saveToken(p, generateToken('pc'));
    // POSIX modes are not meaningful on Windows (the profile ACL applies there).
    if (process.platform !== 'win32') expect(statSync(p.tokenFile).mode & 0o777).toBe(0o600);
    expect(readToken(p)).not.toBeNull();
  });
});
