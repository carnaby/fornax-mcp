import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { FORNAX_VERSION, type TrayBundleInfo, type TrayInstallerInfo } from '@fornax/protocol';
import type { FastifyPluginAsync } from 'fastify';
import { notFound } from '../domain/errors.js';
import type { RouteDeps } from './deps.js';

const TYPES = { msi: 'application/x-msi', deb: 'application/vnd.debian.binary-package' } as const;
type Kind = keyof typeof TYPES;

/** The file's size and mtime, or null when there is none. */
async function fileStat(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** GET /downloads/fornax-tray.{json,msi,deb} (spec 06d 2.1): the tray's installers of this server's version. Public. */
export const trayDownloadRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  const fileOf = (kind: Kind) => (kind === 'msi' ? deps.config.trayMsi : deps.config.trayDeb);
  // Hashed once per version of each file, like the worker bundle.
  const cached = new Map<Kind, { key: string; info: TrayInstallerInfo }>();

  const infoOf = async (kind: Kind): Promise<TrayInstallerInfo | null> => {
    const file = fileOf(kind);
    const s = await fileStat(file);
    if (!s) return null;
    const key = `${s.size}:${s.mtimeMs}`;
    const hit = cached.get(kind);
    if (hit?.key === key) return hit.info;
    const bytes = await readFile(file);
    const info = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    cached.set(kind, { key, info });
    return info;
  };

  app.get('/downloads/fornax-tray.json', async (_req, reply) => {
    const [msi, deb] = await Promise.all([infoOf('msi'), infoOf('deb')]);
    if (!msi && !deb) throw notFound('this server has no tray installer');
    const body: TrayBundleInfo = { version: FORNAX_VERSION, msi, deb };
    return reply.header('cache-control', 'no-cache').send(body);
  });

  for (const kind of ['msi', 'deb'] as const) {
    app.get(`/downloads/fornax-tray.${kind}`, async (_req, reply) => {
      const file = fileOf(kind);
      const s = await fileStat(file);
      if (!s) throw notFound(`this server has no tray installer (${kind})`);
      return reply
        .header('content-type', TYPES[kind])
        .header('content-length', s.size)
        .header('content-disposition', `attachment; filename="fornax-tray-${FORNAX_VERSION}.${kind}"`)
        .header('cache-control', 'no-cache')
        .header('x-content-type-options', 'nosniff')
        .send(createReadStream(file));
    });
  }
};
