import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildCollectionOgImageUrl,
  buildCollectionPageJsonLd,
  decidePublicShellVisibility,
  isSearchIndexableVisibility,
  SEARCH_INDEXABLE_VISIBILITY,
  escapeAttr,
  FALLBACK_CURATOR,
  fallbackCollectionDescription,
  injectPublicCollectionShell,
  normalizeContentLanguage,
  PUBLIC_SHELL_DESCRIPTION_MAX,
  PUBLIC_SHELL_TITLE_MAX,
  sanitizePublicShellText,
  SITE_OG_IMAGE_URL,
  type PublicShellCollectionHeader,
} from '../../../src/infrastructure/http/index.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const baseInput = {
  surface: 'c' as const,
  slug: 'engineering-notes',
  collectionId: 'collection-1',
  title: 'Engineering notes',
  summary: 'Saved links for the team.',
  curator: 'Ada',
  itemCount: 4,
  updatedAt: '2026-08-01T12:00:00.000Z',
  visibility: 'public' as const,
  language: null,
};

function header(overrides: Partial<PublicShellCollectionHeader> = {}): PublicShellCollectionHeader {
  return {
    id: 'collection-1',
    title: 'Engineering notes',
    summary: 'Saved links',
    visibility: 'public',
    ownerSubjectId: 'owner',
    updatedAt: '2026-08-01T12:00:00.000Z',
    deletedAt: null,
    publicationSlug: 'engineering-notes',
    rootAvailable: true,
    language: null,
    ...overrides,
  };
}

test('injects title, description, canonical, CollectionPage JSON-LD, and agent-public', () => {
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, baseInput);
  assert.match(html, /<title>Engineering notes — Know-N<\/title>/u);
  assert.match(html, /<meta property="og:title" content="Engineering notes — Know-N" \/>/u);
  assert.match(html, /<meta name="description" content="Saved links for the team\." \/>/u);
  assert.match(html, /<meta property="og:description" content="Saved links for the team\." \/>/u);
  assert.match(html, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/engineering-notes" \/>/u);
  assert.match(html, /<meta property="og:url" content="https:\/\/know-n\.com\/c\/engineering-notes" \/>/u);
  // D1: the site-wide cover gives way to the per-collection card, versioned
  // by updatedAt so an edit busts social-crawler caches.
  assert.match(html, new RegExp(`<meta property="og:image" content="${buildCollectionOgImageUrl('engineering-notes', '2026-08-01T12:00:00.000Z').replace(/[.?/]/gu, '\\$&')}" \\/>`, 'u'));
  assert.equal(SITE_OG_IMAGE_URL, 'https://know-n.com/og-cover.png');
  assert.match(html, /"@type": "CollectionPage"/u);
  assert.match(html, /"numberOfItems": 4/u);
  assert.match(html, /<h1>Engineering notes<\/h1>/u);
  assert.match(html, /Curated by Ada · 4 items · updated 2026-08-01/u);
  assert.match(html, /href="\/colp\/v0\.1\/collections\/collection-1\/snapshot"/u);
  assert.doesNotMatch(html, /name="robots"/u);
});

test('normalizes only strict supported content-language shapes', () => {
  const cases = [
    ['zh-cn', { htmlLang: 'zh-CN', ogLocale: 'zh_CN' }],
    ['en-us', { htmlLang: 'en-US', ogLocale: 'en_US' }],
    ['ZH-CN', { htmlLang: 'zh-CN', ogLocale: 'zh_CN' }],
    ['zh', { htmlLang: 'zh', ogLocale: null }],
    ['eng', { htmlLang: 'eng', ogLocale: null }],
    [' zh-cn ', null],
    ['zh_CN', null],
    ['zh-cn-extra', null],
    ['z', null],
    ['zh-1a', null],
    ['zh-cn\u0000', null],
    ['', null],
    [null, null],
  ] as const;

  for (const [value, expected] of cases) {
    assert.deepEqual(normalizeContentLanguage(value), expected, String(value));
  }
});

test('injects regional and language-only signals with correct locale cardinality', () => {
  const regional = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, {
    ...baseInput,
    language: 'ZH-CN',
  });
  assert.match(regional, /<html lang="zh-CN">/u);
  assert.match(regional, /<meta property="og:locale" content="zh_CN" \/>/u);
  assert.equal([...regional.matchAll(/property="og:locale"/gu)].length, 1);
  assert.doesNotMatch(regional, /hreflang/iu);

  const languageOnly = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, {
    ...baseInput,
    language: 'zh',
  });
  assert.match(languageOnly, /<html lang="zh">/u);
  assert.doesNotMatch(languageOnly, /property="og:locale"/u);

  for (const language of [null, ' zh-cn ', 'zh-cn\u0000']) {
    const fallback = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, language });
    assert.match(fallback, /<html lang="en">/u);
    assert.match(fallback, /<meta property="og:locale" content="en_US" \/>/u);
    assert.equal([...fallback.matchAll(/property="og:locale"/gu)].length, 1);
  }
});

test('CollectionPage JSON-LD escapes HTML script-breakout characters without changing data', () => {
  const hostile = '</script><script>alert(1)</script><!--&>\u2028\u2029';
  const script = buildCollectionPageJsonLd({
    name: hostile,
    description: hostile,
    url: 'https://know-n.com/c/hostile',
    numberOfItems: 1,
  });
  const body = script.slice(script.indexOf('\n') + 1, script.lastIndexOf('\n    </script>'));

  assert.doesNotMatch(body, /[<>&\u2028\u2029]/u);
  const parsed = JSON.parse(body) as { name: string; description: string };
  assert.equal(parsed.name, hostile);
  assert.equal(parsed.description, hostile);
});

test('share and path keep canonical on /c and og:url on the request surface', () => {
  const share = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, surface: 'share' });
  assert.match(share, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/engineering-notes" \/>/u);
  assert.match(share, /<meta property="og:url" content="https:\/\/know-n\.com\/share\/engineering-notes" \/>/u);
  const path = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, surface: 'path' });
  assert.match(path, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/engineering-notes" \/>/u);
  assert.match(path, /<meta property="og:url" content="https:\/\/know-n\.com\/path\/engineering-notes" \/>/u);
});

test('empty summary falls back to curator copy', () => {
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, summary: null });
  const expected = fallbackCollectionDescription('Ada');
  assert.match(html, new RegExp(`content="${expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'u'));
});

test('unlisted injects robots noindex', () => {
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, visibility: 'unlisted' });
  assert.match(html, /<meta name="robots" content="noindex" \/>/u);
});

test('escapes XSS payloads including "><script>', () => {
  const payload = '"><script>alert(1)</script>';
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, {
    ...baseInput,
    title: payload,
    summary: payload,
    curator: payload,
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, new RegExp(escapeAttr(`${payload} — Know-N`).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(html, /&lt;script&gt;/u);
  assert.match(html, /\\u003cscript/u);
});

test('strips control characters and truncates title and description', () => {
  const title = `A\nB\u0000${'T'.repeat(400)}`;
  const summary = `C\r\n${'D'.repeat(600)}`;
  assert.equal(sanitizePublicShellText(title, PUBLIC_SHELL_TITLE_MAX).includes('\n'), false);
  assert.equal(sanitizePublicShellText(title, PUBLIC_SHELL_TITLE_MAX).length, PUBLIC_SHELL_TITLE_MAX);
  assert.equal(sanitizePublicShellText(summary, PUBLIC_SHELL_DESCRIPTION_MAX).length, PUBLIC_SHELL_DESCRIPTION_MAX);
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, title, summary });
  assert.doesNotMatch(html, /\nB/u);
  assert.equal(html.includes('\u0000'), false);
});

test('long summaries: meta/og get a 160-char sentence-bounded snippet, body and JSON-LD keep the full text', () => {
  const sentence = 'This sentence is exactly long enough to push the description past the limit. ';
  const summary = `${sentence.repeat(4)}Trailing clause with no terminal punctuation at all`;
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, summary });
  const meta = /<meta name="description" content="([^"]*)" \/>/u.exec(html)?.[1];
  const og = /<meta property="og:description" content="([^"]*)" \/>/u.exec(html)?.[1];
  assert.ok(meta);
  assert.equal(og, meta);
  assert.ok(meta.length <= 160, `meta description ${meta.length} chars`);
  assert.ok(meta.endsWith('.'), 'cut at a sentence boundary');
  assert.equal(meta, `${sentence.repeat(2)}`.trim());
  assert.match(html, /<p>This sentence is exactly long enough[^<]*Trailing clause with no terminal punctuation at all<\/p>/u);
  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? '';
  const parsed = JSON.parse(jsonLd) as { description: string };
  assert.ok(parsed.description.endsWith('Trailing clause with no terminal punctuation at all'));
  assert.ok(parsed.description.length > 160);

  const cjk = `${'这是一句足够长的中文摘要，用来把描述推过一百六十个字符的上限。'.repeat(6)}没有句号的尾巴`;
  assert.ok(cjk.length > 160);
  const cjkHtml = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...baseInput, summary: cjk });
  const cjkMeta = /<meta name="description" content="([^"]*)" \/>/u.exec(cjkHtml)?.[1] ?? '';
  assert.ok(cjkMeta.length <= 160);
  assert.ok(cjkMeta.endsWith('。'), 'CJK full stop is a sentence boundary');
});

test('search-indexable visibility is public only (T-10 noindex / T-20 sitemap)', () => {
  assert.equal(SEARCH_INDEXABLE_VISIBILITY, 'public');
  assert.equal(isSearchIndexableVisibility('public'), true);
  assert.equal(isSearchIndexableVisibility('unlisted'), false);
  assert.equal(isSearchIndexableVisibility('private'), false);
  assert.equal(isSearchIndexableVisibility('protected'), false);
});

test('visibility branches: public and unlisted inject; others are generic 404', () => {
  assert.deepEqual(decidePublicShellVisibility(header()), { kind: 'inject', visibility: 'public' });
  assert.deepEqual(
    decidePublicShellVisibility(header({ visibility: 'unlisted' })),
    { kind: 'inject', visibility: 'unlisted' },
  );
  assert.deepEqual(decidePublicShellVisibility(null), { kind: 'generic-404' });
  assert.deepEqual(decidePublicShellVisibility(header({ visibility: 'private' })), { kind: 'generic-404' });
  assert.deepEqual(decidePublicShellVisibility(header({ visibility: 'protected' })), { kind: 'generic-404' });
  assert.deepEqual(decidePublicShellVisibility(header({ publicationSlug: null })), { kind: 'generic-404' });
  assert.deepEqual(decidePublicShellVisibility(header({ deletedAt: '2026-07-01T00:00:00.000Z' })), {
    kind: 'generic-404',
  });
  assert.deepEqual(decidePublicShellVisibility(header({ rootAvailable: false })), { kind: 'generic-404' });
});

test('fallback curator is Know-N', () => {
  assert.equal(FALLBACK_CURATOR, 'Know-N');
});
