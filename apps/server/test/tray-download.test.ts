import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { FORNAX_VERSION } from '@fornax/protocol';
import { expect, test } from 'vitest';
import { useTestApp } from './helpers.js';

const t = useTestApp();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('GET /downloads/fornax-tray.json: the version and both installers, recomputed when one changes', async () => {
  const msi = Buffer.from('fake msi');
  const deb = Buffer.from('fake deb, longer');
  writeFileSync(t.config.trayMsi, msi);
  writeFileSync(t.config.trayDeb, deb);
  const a = await t.app.inject({ method: 'GET', url: '/downloads/fornax-tray.json' });
  expect(a.statusCode).toBe(200);
  expect(a.headers['cache-control']).toBe('no-cache');
  expect(a.json()).toEqual({ version: FORNAX_VERSION, msi: { sha256: sha(msi), size: msi.length }, deb: { sha256: sha(deb), size: deb.length } });
  const msi2 = Buffer.from('another fake msi');
  writeFileSync(t.config.trayMsi, msi2);
  rmSync(t.config.trayDeb);
  const b = await t.app.inject({ method: 'GET', url: '/downloads/fornax-tray.json' });
  expect(b.json()).toEqual({ version: FORNAX_VERSION, msi: { sha256: sha(msi2), size: msi2.length }, deb: null });
  rmSync(t.config.trayMsi);
  const c = await t.app.inject({ method: 'GET', url: '/downloads/fornax-tray.json' });
  expect(c.statusCode).toBe(404);
  expect(c.json().message).toBe('this server has no tray installer');
});

test('GET /downloads/fornax-tray.msi and .deb serve the installers without a token; a missing one is 404', async () => {
  const msi = Buffer.from('fake msi');
  writeFileSync(t.config.trayMsi, msi);
  const res = await t.app.inject({ method: 'GET', url: '/downloads/fornax-tray.msi' });
  expect(res.statusCode).toBe(200);
  expect(res.rawPayload.equals(msi)).toBe(true);
  expect(res.headers['content-disposition']).toBe(`attachment; filename="fornax-tray-${FORNAX_VERSION}.msi"`);
  expect(res.headers['cache-control']).toBe('no-cache');
  const missing = await t.app.inject({ method: 'GET', url: '/downloads/fornax-tray.deb' });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().message).toBe('this server has no tray installer (deb)');
});
