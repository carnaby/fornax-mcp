import { describe, expect, test } from 'vitest';
import { HOME_CSP } from '../src/http/pages/home.js';
import { useTestApp } from './helpers.js';

const t = useTestApp();

describe('the home page', () => {
  test('/ shows the logo, the name and the subtitle, with its headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8', 'content-security-policy': HOME_CSP, 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    expect(HOME_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(res.body).toMatch(/^<!doctype html>/);
    expect(res.body).toContain('<title>Fornax</title>');
    expect(res.body).toContain('<h1>Fornax</h1>');
    expect(res.body).toContain('One GPU, many agents.');
    expect(res.body).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  test('nothing more: no script, link, form, image file or external resource', async () => {
    const body = (await t.app.inject({ method: 'GET', url: '/' })).body;
    expect(body).not.toMatch(/<script|<a\b|<form|<img|<link|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });

  test('HEAD answers too, and another unknown path is still not found', async () => {
    expect((await t.app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/nothing-here' })).statusCode).toBe(404);
  });
});
