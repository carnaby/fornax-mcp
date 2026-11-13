import { z } from 'zod';

const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const description = z.string().max(500).optional();

const stringProp = z.strictObject({
  type: z.literal('string'),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).max(10_000).optional(),
  pattern: z.string().max(200).optional(),
  default: z.string().optional(),
  description,
});
const integerProp = z.strictObject({
  type: z.literal('integer'),
  minimum: z.number().int().optional(),
  maximum: z.number().int().optional(),
  default: z.number().int().optional(),
  description,
});
const numberProp = z.strictObject({
  type: z.literal('number'),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.number().optional(),
  description,
});
const booleanProp = z.strictObject({ type: z.literal('boolean'), default: z.boolean().optional(), description });
const enumProp = z.strictObject({
  enum: z.array(z.union([z.string(), z.number()])).min(1).max(100),
  default: z.union([z.string(), z.number()]).optional(),
  description,
});
const scalarProp = z.union([stringProp, integerProp, numberProp, booleanProp, enumProp]);
const arrayProp = z.strictObject({
  type: z.literal('array'),
  items: scalarProp,
  maxItems: z.number().int().min(1).max(1000),
  default: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  description,
});

export type ScalarProperty = z.infer<typeof scalarProp>;
export type ParamProperty = ScalarProperty | z.infer<typeof arrayProp>;

/** C0 and C1 control characters, plus the line and paragraph separators some tools treat as line breaks. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
export const hasControlChars = (s: string): boolean => CONTROL.test(s);

/** Mistakes in one property's definition that its shape alone does not catch. */
function definitionProblems(p: ParamProperty): string[] {
  const out: string[] = [];
  if ('pattern' in p && p.pattern !== undefined) {
    try {
      new RegExp(p.pattern, 'u');
    } catch {
      out.push('pattern does not compile');
    }
  }
  if ('type' in p && (p.type === 'integer' || p.type === 'number') && p.minimum !== undefined && p.maximum !== undefined && p.minimum > p.maximum) {
    out.push('minimum is greater than maximum');
  }
  if ('type' in p && p.type === 'string' && p.minLength !== undefined && p.maxLength !== undefined && p.minLength > p.maxLength) {
    out.push('minLength is greater than maxLength');
  }
  if (!('type' in p)) {
    for (const m of p.enum) {
      if (typeof m === 'string' && (m.startsWith('-') || hasControlChars(m))) {
        out.push(`enum member ${JSON.stringify(m)} must not start with "-" or contain control characters`);
      }
    }
  }
  return out;
}

function checkString(p: z.infer<typeof stringProp>, v: string): string | null {
  // A value starting with "-" could be read as an option by the tool, even as a single argv element.
  if (v.startsWith('-')) return 'must not start with "-"';
  if (hasControlChars(v)) return 'must not contain control characters';
  const len = [...v].length;
  if (p.minLength !== undefined && len < p.minLength) return `must be at least ${p.minLength} characters`;
  if (p.maxLength !== undefined && len > p.maxLength) return `must be at most ${p.maxLength} characters`;
  if (p.pattern !== undefined && !new RegExp(`^(?:${p.pattern})$`, 'u').test(v)) return 'does not match the pattern';
  return null;
}

function checkRange(p: { minimum?: number; maximum?: number }, v: number): string | null {
  if (p.minimum !== undefined && v < p.minimum) return `must be at least ${p.minimum}`;
  if (p.maximum !== undefined && v > p.maximum) return `must be at most ${p.maximum}`;
  return null;
}

function checkScalar(p: ScalarProperty, v: unknown): string | null {
  if (!('type' in p)) {
    if (typeof v === 'string' && (v.startsWith('-') || hasControlChars(v))) return 'is not allowed';
    return p.enum.includes(v as string | number) ? null : `must be one of ${p.enum.join(', ')}`;
  }
  switch (p.type) {
    case 'string':
      return typeof v === 'string' ? checkString(p, v) : 'must be a string';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) ? checkRange(p, v) : 'must be a whole number';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? checkRange(p, v) : 'must be a number';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be true or false';
  }
}

function checkValue(p: ParamProperty, v: unknown): string | null {
  if ('type' in p && p.type === 'array') {
    if (!Array.isArray(v)) return 'must be a list';
    if (v.length > p.maxItems) return `must have at most ${p.maxItems} items`;
    for (const [i, item] of v.entries()) {
      const err = checkScalar(p.items, item);
      if (err) return `item ${i} ${err}`;
    }
    return null;
  }
  return checkScalar(p as ScalarProperty, v);
}

/** The allowed subset of JSON Schema for job parameters (spec 6.2). Anything else is refused when a type pack loads. */
export const paramSchema = z
  .strictObject({
    type: z.literal('object'),
    additionalProperties: z.literal(false),
    required: z.array(z.string()).max(100).optional(),
    properties: z.record(z.string().regex(PARAM_NAME), z.union([scalarProp, arrayProp])),
  })
  .superRefine((s, ctx) => {
    for (const r of s.required ?? []) {
      if (!Object.hasOwn(s.properties, r)) ctx.addIssue({ code: 'custom', message: `required "${r}" is not a property` });
    }
    for (const [name, prop] of Object.entries(s.properties)) {
      const parts: ParamProperty[] = [prop, ...('items' in prop ? [prop.items] : [])];
      for (const p of parts) {
        for (const problem of definitionProblems(p)) ctx.addIssue({ code: 'custom', message: `${name}: ${problem}` });
      }
      if (prop.default !== undefined) {
        const err = checkValue(prop, prop.default);
        if (err) ctx.addIssue({ code: 'custom', message: `${name}: default ${err}` });
      }
    }
  });

export type ParamSchema = z.infer<typeof paramSchema>;
export type ParamsResult = { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };

/** Validate job params against a type's schema; on success the value has defaults filled in. */
export function validateParams(schema: ParamSchema, input: unknown): ParamsResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['params must be an object'] };
  const given = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(schema.properties, key)) errors.push(`${key}: unknown parameter`);
  }
  const value: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    let v = Object.hasOwn(given, key) ? given[key] : undefined;
    if (v === undefined) {
      if (prop.default === undefined) {
        if (schema.required?.includes(key)) errors.push(`${key}: required`);
        continue;
      }
      v = prop.default;
    }
    const err = checkValue(prop, v);
    if (err) errors.push(`${key}: ${err}`);
    else value[key] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
