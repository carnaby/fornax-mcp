import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { FileStore } from '../files/store.js';

export type RouteDeps = { config: Config; db: Db; store: FileStore; clock: () => Date };
