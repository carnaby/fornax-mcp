import { contractHash, defaultPriority, type JobTypeContract } from '@fornax/protocol';
import { and, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobTypes } from '../db/schema.js';
import { badRequest } from './errors.js';
import { jobChanges, jobSignal } from './signal.js';

/** A type the worker offers, with what its check said it runs with (spec 12 § 3.2). */
export type OfferedType = { contract: JobTypeContract; environment: string | null };

/**
 * The worker's announcement is the truth: exactly these types are offered from now on, each with the environment line
 * the announcement gives it or none (an older worker sends no lines: old ones are cleared, not kept).
 */
export function announceTypes(db: Db, contracts: JobTypeContract[], now: Date, environments: Record<string, string> = {}): { offered: string[] } {
  const names = contracts.map((c) => c.name);
  if (new Set(names).size !== names.length) throw badRequest('a type name appears twice');
  const stray = Object.keys(environments).find((n) => !names.includes(n));
  if (stray !== undefined) throw badRequest(`environments names ${stray}, a type this announcement does not offer`);
  db.transaction((tx) => {
    for (const c of contracts) {
      // Own keys only: a type named "constructor" must not find Object.prototype.constructor.
      const environment = Object.prototype.hasOwnProperty.call(environments, c.name) ? environments[c.name]! : null;
      const values = { contract: c, contractHash: contractHash(c), offered: true, lastOfferedAt: now, environment };
      tx.insert(jobTypes).values({ name: c.name, ...values }).onConflictDoUpdate({ target: jobTypes.name, set: values }).run();
    }
    const withdrawn = names.length ? and(eq(jobTypes.offered, true), notInArray(jobTypes.name, names)) : eq(jobTypes.offered, true);
    tx.update(jobTypes).set({ offered: false, lastOfferedAt: now }).where(withdrawn).run();
  });
  jobSignal.wake();
  jobChanges.wake();
  return { offered: [...names].sort() };
}

export function getOfferedType(db: Db, name: string): JobTypeContract | null {
  return db.select().from(jobTypes).where(and(eq(jobTypes.name, name), eq(jobTypes.offered, true))).get()?.contract ?? null;
}

export const isOffered = (db: Db, name: string): boolean => getOfferedType(db, name) !== null;

export function offeredTypes(db: Db): OfferedType[] {
  return db
    .select().from(jobTypes).where(eq(jobTypes.offered, true)).orderBy(jobTypes.name).all()
    .map((r) => ({ contract: r.contract, environment: r.environment ?? null }));
}

export const typeView = ({ contract: c, environment }: OfferedType) => ({
  name: c.name, version: c.version, description: c.description, inputs: c.inputs, params: c.params, max_runtime_s: c.max_runtime_s,
  default_priority: defaultPriority(c), environment,
});
