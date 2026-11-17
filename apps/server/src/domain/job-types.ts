import { contractHash, defaultPriority, type JobTypeContract } from '@fornax/protocol';
import { and, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobTypes } from '../db/schema.js';
import { badRequest } from './errors.js';
import { jobChanges, jobSignal } from './signal.js';

/** The worker's announcement is the truth: exactly these types are offered from now on. */
export function announceTypes(db: Db, contracts: JobTypeContract[], now: Date): { offered: string[] } {
  const names = contracts.map((c) => c.name);
  if (new Set(names).size !== names.length) throw badRequest('a type name appears twice');
  db.transaction((tx) => {
    for (const c of contracts) {
      const values = { contract: c, contractHash: contractHash(c), offered: true, lastOfferedAt: now };
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

export function offeredTypes(db: Db): JobTypeContract[] {
  return db.select().from(jobTypes).where(eq(jobTypes.offered, true)).orderBy(jobTypes.name).all().map((r) => r.contract);
}

export const typeView = (c: JobTypeContract) => ({
  name: c.name, version: c.version, description: c.description, inputs: c.inputs, params: c.params, max_runtime_s: c.max_runtime_s,
  default_priority: defaultPriority(c),
});
