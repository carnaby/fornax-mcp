import { describe, expect, test } from 'vitest';
import { canonicalJson, contractHash, jobTypeContract } from '../src/contract.js';

const render = {
  name: 'render',
  version: 1,
  description: 'Render frames with Cycles.',
  inputs: { scene: { extensions: ['.blend'], max_mb: 2048 } },
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['frame_start'],
    properties: { frame_start: { type: 'integer', minimum: 0 } },
  },
  max_runtime_s: 21600,
};

describe('jobTypeContract', () => {
  test('parses a valid contract and defaults required to true', () => {
    const c = jobTypeContract.parse(render);
    expect(c.inputs.scene!.required).toBe(true);
  });
  test('refuses bad names, extensions and runtimes', () => {
    expect(jobTypeContract.safeParse({ ...render, name: 'Render' }).success).toBe(false);
    expect(jobTypeContract.safeParse({ ...render, inputs: { scene: { extensions: ['blend'], max_mb: 1 } } }).success).toBe(false);
    expect(jobTypeContract.safeParse({ ...render, max_runtime_s: 0 }).success).toBe(false);
    expect(jobTypeContract.safeParse({ ...render, run: ['x'] }).success).toBe(false);
  });
});

describe('contractHash', () => {
  test('does not depend on key order', () => {
    const a = jobTypeContract.parse(render);
    const b = jobTypeContract.parse({ max_runtime_s: 21600, params: render.params, inputs: render.inputs, description: render.description, version: 1, name: 'render' });
    expect(contractHash(a)).toBe(contractHash(b));
    expect(contractHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('changes with the contract', () => {
    const a = jobTypeContract.parse(render);
    const b = jobTypeContract.parse({ ...render, version: 2 });
    expect(contractHash(a)).not.toBe(contractHash(b));
  });
  test('canonicalJson sorts keys deeply and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});

import { defaultPriority } from '../src/contract.js';

describe('default_priority (spec 07 § 4.4)', () => {
  test('optional; without it the type runs as normal and its hash does not change', () => {
    const plain = jobTypeContract.parse(render);
    expect(plain.default_priority).toBeUndefined();
    expect(defaultPriority(plain)).toBe('normal');
    expect(contractHash(jobTypeContract.parse({ ...render }))).toBe(contractHash(plain));
    expect(contractHash(plain)).toBe(contractHash(jobTypeContract.parse({ ...render, default_priority: undefined })));
  });

  test('idle and high are kept; low and other words are refused', () => {
    expect(defaultPriority(jobTypeContract.parse({ ...render, default_priority: 'idle' }))).toBe('idle');
    expect(defaultPriority(jobTypeContract.parse({ ...render, default_priority: 'high' }))).toBe('high');
    expect(jobTypeContract.safeParse({ ...render, default_priority: 'low' }).success).toBe(false);
    expect(jobTypeContract.safeParse({ ...render, default_priority: 'soon' }).success).toBe(false);
  });
});
