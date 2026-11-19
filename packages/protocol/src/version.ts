/**
 * The version of every Fornax package (server, worker, protocol, tray), released together. The worker sends it as
 * X-Fornax-Version and the server warns on a mismatch (spec 3). Equal to each package.json (a test checks).
 */
export const FORNAX_VERSION = '0.12.0';
