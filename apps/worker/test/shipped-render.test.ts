import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadPack } from '../src/pack.js';

const shipped = fileURLToPath(new URL('../../../types/render', import.meta.url));

test('the shipped render pack is contract version 3 with engine and samples without a default (spec 15 § 2)', () => {
  const { contract } = loadPack(shipped);
  expect(contract.version).toBe(3);
  expect(contract.description).toContain('Cycles (default) or Eevee');
  const { properties } = contract.params;
  expect(properties.engine).toMatchObject({ enum: ['cycles', 'eevee'], default: 'cycles' });
  expect(properties.engine!.description).toContain('Eevee unavailable');
  expect(properties.samples).toMatchObject({ type: 'integer', minimum: 1, maximum: 4096 });
  expect(properties.samples).not.toHaveProperty('default');
  expect(properties.samples!.description).toContain('128 when left out');
  expect(properties.samples!.description).toContain('64 when left out');
});
