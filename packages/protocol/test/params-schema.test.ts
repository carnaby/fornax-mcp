import { describe, expect, test } from 'vitest';
import { hasControlChars, paramSchema, validateParams } from '../src/params-schema.js';

const schema = paramSchema.parse({
  type: 'object',
  additionalProperties: false,
  required: ['frame_start'],
  properties: {
    frame_start: { type: 'integer', minimum: 0 },
    samples: { type: 'integer', minimum: 1, maximum: 4096, default: 128 },
    format: { enum: ['png', 'jpg'], default: 'png' },
    language: { type: 'string', pattern: '[a-z]{2}', maxLength: 2 },
    title: { type: 'string', maxLength: 20 },
    code: { type: 'string', pattern: '[a-z]{2}' },
    ab: { type: 'string', pattern: 'a|b' },
    diarize: { type: 'boolean', default: false },
    tags: { type: 'array', items: { type: 'string', maxLength: 10 }, maxItems: 2 },
  },
});

describe('paramSchema (definition)', () => {
  test('requires additionalProperties false', () => {
    expect(paramSchema.safeParse({ type: 'object', additionalProperties: true, properties: {} }).success).toBe(false);
  });
  test('refuses keywords outside the subset', () => {
    const r = paramSchema.safeParse({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', format: 'uri' } } });
    expect(r.success).toBe(false);
  });
  test('refuses required names that are not properties', () => {
    expect(paramSchema.safeParse({ type: 'object', additionalProperties: false, required: ['x'], properties: {} }).success).toBe(false);
  });
  test('refuses a pattern that does not compile', () => {
    const r = paramSchema.safeParse({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', pattern: '(' } } });
    expect(r.success).toBe(false);
  });
  test('refuses a default that breaks its own property', () => {
    const r = paramSchema.safeParse({ type: 'object', additionalProperties: false, properties: { a: { type: 'integer', maximum: 3, default: 9 } } });
    expect(r.success).toBe(false);
  });
});

describe('validateParams', () => {
  test('fills defaults', () => {
    expect(validateParams(schema, { frame_start: 1 })).toEqual({
      ok: true,
      value: { frame_start: 1, samples: 128, format: 'png', diarize: false },
    });
  });
  test('reports unknown keys and missing required', () => {
    const r = validateParams(schema, { nope: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['nope: unknown parameter', 'frame_start: required']);
  });
  test('refuses __proto__ as a key', () => {
    const r = validateParams(schema, JSON.parse('{"frame_start":1,"__proto__":{"x":1}}'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('__proto__: unknown parameter');
  });
  test('checks integer bounds and type', () => {
    expect(validateParams(schema, { frame_start: -1 }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 1.5 }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: '1' }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, samples: 4097 }).ok).toBe(false);
  });
  test('checks enum', () => {
    expect(validateParams(schema, { frame_start: 0, format: 'exr' }).ok).toBe(false);
  });
  test('refuses strings starting with a dash or holding control characters', () => {
    expect(validateParams(schema, { frame_start: 0, title: '--python-expr' }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, title: 'a\nb' }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, title: 'a\u0000' }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, title: 'fine - here' }).ok).toBe(true);
  });
  test('pattern is anchored', () => {
    expect(validateParams(schema, { frame_start: 0, language: 'sk' }).ok).toBe(true);
    expect(validateParams(schema, { frame_start: 0, language: 'xsk' }).ok).toBe(false);
    // No maxLength here, so only the anchoring can refuse these.
    expect(validateParams(schema, { frame_start: 0, code: 'sk' }).ok).toBe(true);
    expect(validateParams(schema, { frame_start: 0, code: 'xsk' }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, code: 'skx' }).ok).toBe(false);
    // The (?:...) group keeps the alternation inside the anchors.
    expect(validateParams(schema, { frame_start: 0, ab: 'a' }).ok).toBe(true);
    expect(validateParams(schema, { frame_start: 0, ab: 'ab' }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, ab: 'xb' }).ok).toBe(false);
  });
  test('checks arrays item by item and maxItems', () => {
    expect(validateParams(schema, { frame_start: 0, tags: ['a', 'b'] }).ok).toBe(true);
    expect(validateParams(schema, { frame_start: 0, tags: ['a', 'b', 'c'] }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, tags: ['-a'] }).ok).toBe(false);
    expect(validateParams(schema, { frame_start: 0, tags: 'a' }).ok).toBe(false);
  });
  test('params must be an object', () => {
    expect(validateParams(schema, [1]).ok).toBe(false);
    expect(validateParams(schema, null).ok).toBe(false);
  });
});

describe('stricter strings and definitions', () => {
  const one = (prop: object) => paramSchema.safeParse({ type: 'object', additionalProperties: false, properties: { x: prop } });

  test('C1 control characters and line separators are refused in values', () => {
    for (const bad of ['a\u0085b', 'a\u009bb', 'a\u2028b', 'a\u2029b']) {
      expect(validateParams(schema, { frame_start: 0, title: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(hasControlChars('a\u0085')).toBe(true);
    expect(hasControlChars('plain é')).toBe(false);
  });

  test('inconsistent bounds are refused when the pack loads', () => {
    expect(one({ type: 'integer', minimum: 5, maximum: 1 }).success).toBe(false);
    expect(one({ type: 'number', minimum: 1.5, maximum: 1 }).success).toBe(false);
    expect(one({ type: 'string', minLength: 5, maxLength: 2 }).success).toBe(false);
    expect(one({ type: 'array', items: { type: 'integer', minimum: 3, maximum: 2 }, maxItems: 2 }).success).toBe(false);
    expect(one({ type: 'integer', minimum: 1, maximum: 1 }).success).toBe(true);
  });

  test('enum members may not start with "-" or hold control characters', () => {
    expect(one({ enum: ['ok', '-rf'] }).success).toBe(false);
    expect(one({ enum: ['a\nb'] }).success).toBe(false);
    expect(one({ type: 'array', items: { enum: ['--x'] }, maxItems: 1 }).success).toBe(false);
    expect(one({ enum: ['a-b', -1] }).success).toBe(true);
  });
});
