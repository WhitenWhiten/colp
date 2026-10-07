import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildProfilePageJsonLd,
  buildPublicProfileMarkdown,
  buildPublicProfileMarkdownNotFound,
  injectPublicProfileShell,
  isIndexableProfile,
} from '../../../src/infrastructure/http/index.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const collections = [
  { slug: 'engineering-notes', title: 'Engineering notes', updatedAt: '2026-08-20T00:00:00.000Z' },
  { slug: 'reading-path', title: 'Reading [path]', updatedAt: '2026-08-21T00:00:00.000Z' },
] as const;

const profile = {
  handle: 'ada_curator',
  displayName: 'Ada Curator',
  bio: 'I curate systems reading. Second sentence that remains in the bio.',
  collections,
  hasMoreCollections: false,
};

test('injects canonical profile metadata, public-only JSON-LD, and real collection links', () => {
  const html = injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, profile);
  assert.match(html, /<title>Ada Curator \(@ada_curator\) — Know-N<\/title>/u);
  assert.match(html, /<meta name="description" content="I curate systems reading\. Second sentence that remains in the bio\." \/>/u);
  assert.match(html, /<link rel="canonical" href="https:\/\/know-n\.com\/u\/ada_curator" \/>/u);
  assert.match(html, /<meta property="og:url" content="https:\/\/know-n\.com\/u\/ada_curator" \/>/u);
  assert.match(html, /<meta property="og:type" content="profile" \/>/u);
  assert.match(html, /<meta property="og:image" content="https:\/\/know-n\.com\/og-cover\.png" \/>/u);
  assert.match(html, /"@type": "ProfilePage"/u);
  assert.match(html, /"@type": "Person"/u);
  assert.match(html, /<h1>Ada Curator<\/h1>/u);
  assert.match(html, /<p>I curate systems reading\. Second sentence/u);
  assert.match(html, /<a href="\/c\/engineering-notes">Engineering notes<\/a>/u);
  assert.match(html, /<a href="\/c\/reading-path">Reading \[path\]<\/a>/u);
  assert.doesNotMatch(html, /name="robots"/u);
  assert.doesNotMatch(html, /avatar|email|accountId|profileId|ownerSubjectId|follow/iu);
});

test('zero-public-collection profile is thin noindex and uses the count fallback', () => {
  assert.equal(isIndexableProfile(profile), true);
  assert.equal(isIndexableProfile({ ...profile, collections: [] }), false);
  const html = injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, {
    ...profile,
    displayName: 'Ada',
    bio: '',
    collections: [],
  });
  assert.match(html, /content="Ada curates 0 public collections on Know-N"/u);
  assert.match(html, /<meta name="robots" content="noindex" \/>/u);
});

test('description grammar is honest for one collection and a truncated 100-item page', () => {
  const one = injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, {
    ...profile,
    bio: '',
    collections: collections.slice(0, 1),
  });
  assert.match(one, /content="Ada Curator curates 1 public collection on Know-N"/u);

  const firstHundred = Array.from({ length: 100 }, (_, index) => ({
    slug: `collection-${index}`,
    title: `Collection ${index}`,
    updatedAt: '2026-08-20T00:00:00Z',
  }));
  const more = injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, {
    ...profile,
    bio: '',
    collections: firstHundred,
    hasMoreCollections: true,
  });
  assert.match(more, /content="Ada Curator curates more than 100 public collections on Know-N"/u);
  assert.match(more, /More public collections are available\./u);

  const markdown = buildPublicProfileMarkdown({
    ...profile,
    bio: '',
    collections: firstHundred,
    hasMoreCollections: true,
  });
  assert.match(markdown, /more than 100 public collections/u);
  assert.match(markdown, /More public collections are available\./u);
});

test('pure HTML and markdown builders fail closed on hostile or non-canonical handles', () => {
  for (const handle of ['\"><script>', 'UPPER', '.', '..', 'a/b', 'white space']) {
    assert.throws(
      () => injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, { ...profile, handle }),
      /canonical public Profile handle/u,
      handle,
    );
    assert.throws(
      () => buildPublicProfileMarkdown({ ...profile, handle }),
      /canonical public Profile handle/u,
      handle,
    );
  }
});

test('profile JSON-LD is script-breakout safe and contains only public Person fields', () => {
  const hostile = '</ScRiPt><script>alert(1)</script><!--&>\u2028\u2029';
  const script = buildProfilePageJsonLd({ name: hostile, url: 'https://know-n.com/u/hostile' });
  const body = script.slice(script.indexOf('\n') + 1, script.lastIndexOf('\n    </script>'));
  assert.doesNotMatch(body, /[<>&\u2028\u2029]/u);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['@context', '@type', 'mainEntity', 'url']);
  assert.deepEqual(Object.keys(parsed.mainEntity as Record<string, unknown>).sort(), ['@type', 'name', 'url']);
  assert.equal((parsed.mainEntity as { name: string }).name, hostile);
});

test('escapes hostile user fields and strips controls/newlines with bounded metadata', () => {
  const hostile = '\"><script>alert(1)</script>';
  const long = `First sentence.\n\n${'Z'.repeat(2_500)}`;
  const html = injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, {
    handle: 'safe_handle',
    displayName: `${hostile}\n${'N'.repeat(300)}`,
    bio: `${hostile}\u0000\n${long}`,
    collections: [{ slug: 'safe-slug', title: `${hostile}\n${'T'.repeat(500)}`, updatedAt: '2026-08-20T00:00:00Z' }],
    hasMoreCollections: false,
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('\u0000'), false);
  assert.match(html, /&lt;script&gt;/u);
  const title = /<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? '';
  const description = /<meta name="description" content="([^"]*)"/u.exec(html)?.[1] ?? '';
  assert.ok(title.length <= 220, title.length.toString());
  assert.ok(description.length <= 160, description.length.toString());
});

test('profile markdown escapes all syntax breakers, links collections, and has a short 404', () => {
  const markdown = buildPublicProfileMarkdown({
    handle: 'ada_curator',
    displayName: '\\ [Ada] (Curator) <script>',
    bio: 'Bio \\ [x] (y) <tag>\nwith controls\u0000',
    collections: [{ slug: 'safe-slug', title: '\\ [Title] (x) <b>', updatedAt: '2026-08-20T00:00:00Z' }],
    hasMoreCollections: false,
  });
  assert.ok(markdown.includes('# \\\\ \\[Ada\\] \\(Curator\\) &lt;script&gt;'));
  assert.ok(markdown.includes('Bio \\\\ \\[x\\] \\(y\\) &lt;tag&gt;with controls'));
  assert.ok(markdown.includes('- [\\\\ \\[Title\\] \\(x\\) &lt;b&gt;](/c/safe-slug)'));
  assert.match(markdown, /\[llms\.txt\]\(\/llms\.txt\)/u);
  assert.doesNotMatch(markdown, /\u0000/u);

  const missing = buildPublicProfileMarkdownNotFound();
  assert.match(missing, /^# Profile not found/mu);
  assert.match(missing, /\/sitemap\.xml/u);
  assert.match(missing, /\/llms\.txt/u);
});
