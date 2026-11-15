/** Types for zip.mjs, so that tests can build zips with the bundle's own writer. */
export function zipBuffer(entries: { name: string; data: Buffer; mode?: number }[]): Buffer;
