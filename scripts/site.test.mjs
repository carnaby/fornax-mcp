// The landing page (site/, spec 2026-11-19): a static page for GitHub Pages. Checks what a broken link, a missing
// file or a private detail would break. Run by pnpm test: node --test scripts/site.test.mjs.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const html = readFileSync(join(site, 'index.html'), 'utf8');
const css = readFileSync(join(site, 'style.css'), 'utf8');
const REPO = 'https://github.com/carnaby/fornax-mcp';
const PAGE = 'https://carnaby.github.io/fornax-mcp/';
/** The only hosts the page may name. */
const HOSTS = ['fornax.example.com', 'github.com', 'carnaby.github.io', 'ghcr.io', 'claude.ai'];

const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => m[0]);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** Every href and src of the page and every url() of the stylesheet. */
const refs = [
  ...[...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]),
  ...[...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, '')),
];
const local = refs.filter((r) => !/^(https?:|mailto:|#)/.test(r));
/** GitHub's anchor of a heading: lower case, punctuation dropped, spaces as hyphens. */
const slug = (heading) =>
  heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-');

test('one h1, a language, a title and a description', () => {
  assert.equal(tags('h1').length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{40,}">/);
});

test('every image has alt, width and height', () => {
  const imgs = tags('img');
  assert.ok(imgs.length >= 5, 'the page shows its screenshots');
  for (const img of imgs) {
    assert.notEqual(attr(img, 'alt'), undefined, img);
    assert.match(attr(img, 'width') ?? '', /^\d+$/, img);
    assert.match(attr(img, 'height') ?? '', /^\d+$/, img);
  }
});

test('every path is relative', () => {
  for (const r of local) assert.ok(!r.startsWith('/'), r);
});

test('every file the page and the stylesheet name exists', () => {
  for (const r of local) assert.ok(existsSync(join(site, r.split(/[?#]/)[0])), r);
});

test('every in-page anchor has its target', () => {
  for (const r of refs.filter((x) => x.startsWith('#') && x.length > 1)) {
    assert.match(html, new RegExp(`\\sid="${r.slice(1)}"`), r);
  }
});

test('README links name headings that exist', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const anchors = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  const links = refs.filter((r) => r.startsWith(`${REPO}#`));
  assert.ok(links.length >= 4, 'Get started links its four README sections');
  for (const r of links) assert.ok(anchors.has(r.slice(REPO.length + 1)), r);
});

test('absolute links go only to the repository or to the page itself', () => {
  for (const r of refs.filter((x) => /^https?:/.test(x))) assert.ok(r.startsWith(REPO) || r.startsWith(PAGE), r);
});

test('nothing private in the page: no script, address, path or host other than the known ones', () => {
  // The loopback address of the docker run example is nobody's address.
  const text = (html + css).replaceAll('127.0.0.1', 'loopback');
  assert.doesNotMatch(text, /<script/i);
  assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b/, 'an IP address');
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, 'an e-mail address');
  assert.doesNotMatch(text, /[A-Za-z]:\\Users|\/home\/|\/Users\//, 'a machine path');
  for (const m of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|sk|ai|dev|app)\b/gi)) {
    assert.ok(HOSTS.includes(m[0].toLowerCase()), m[0]);
  }
});

test('every image is at most 300 KB', () => {
  for (const f of readdirSync(join(site, 'img'))) assert.ok(statSync(join(site, 'img', f)).size <= 300_000, f);
});
