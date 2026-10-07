import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  buildPublicExploreMarkdown,
  injectPublicExploreShell,
  normalizeExploreItems,
  PUBLIC_EXPLORE_DESCRIPTION,
  PUBLIC_EXPLORE_ITEM_LIMIT,
  PUBLIC_EXPLORE_TITLE,
  truncatePublicShellDescription,
} from '../../../src/infrastructure/http/index.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const items = [
  {
    slug: 'llm-learning-path',
    title: 'LLM learning path',
    summary: 'From intuition to Transformers. Then alignment and fine-tuning for engineers.',
    nodeCount: 34,
    updatedAt: '2026-08-29T04:19:21.427Z',
  },
  {
    slug: 'design-inspiration',
    title: 'Design [inspiration] <b>',
    summary: null,
    nodeCount: 1,
    updatedAt: '2026-08-30T05:57:39.270Z',
  },
] as const;

test('injects the Explore head, ItemList JSON-LD, and real /c/ links into the no-JS body', () => {
  const html = injectPublicExploreShell(PUBLIC_SHELL_FIXTURE, items);
  assert.match(html, /<title>Explore — Know-N<\/title>/u);
  assert.match(html, /<meta property="og:title" content="Explore — Know-N" \/>/u);
  assert.match(html, new RegExp(`<meta name="description" content="${PUBLIC_EXPLORE_DESCRIPTION}" />`, 'u'));
  assert.match(html, /<link rel="canonical" href="https:\/\/know-n\.com\/explore" \/>/u);
  assert.match(html, /<meta property="og:url" content="https:\/\/know-n\.com\/explore" \/>/u);
  assert.doesNotMatch(html, /href="https:\/\/know-n\.com\/" \/>/u);
  assert.match(html, /"@type": "CollectionPage"/u);
  assert.match(html, /"@type": "ItemList"/u);
  assert.match(html, /"numberOfItems": 2/u);
  assert.match(html, /"position": 1,\s*"url": "https:\/\/know-n\.com\/c\/llm-learning-path",\s*"name": "LLM learning path"/u);
  assert.match(html, /<h1>Explore collections<\/h1>/u);
  assert.match(html, /<a href="\/c\/llm-learning-path">LLM learning path<\/a> — From intuition to Transformers\. Then alignment and fine-tuning for engineers\. · 34 items · updated 2026-08-29<\/li>/u);
  assert.match(html, /<a href="\/c\/design-inspiration">Design \[inspiration\] &lt;b&gt;<\/a> · 1 item · updated 2026-08-30<\/li>/u);
  assert.match(html, /<a href="\/sitemap-collections\.xml">All public collections<\/a>/u);
  assert.doesNotMatch(html, /name="robots"/u);
  assert.doesNotMatch(html, /Home fallback/u);
});

test('escapes hostile titles, drops non-canonical slugs, and bounds the list', () => {
  const hostile = [
    { slug: 'ok-slug', title: '"><script>alert(1)</script>', summary: '<img src=x onerror=alert(1)>', nodeCount: 2, updatedAt: '2026-08-01T00:00:00Z' },
    { slug: '../etc/passwd', title: 'traversal', summary: null, nodeCount: 0, updatedAt: '2026-08-01T00:00:00Z' },
    { slug: 'ok-slug', title: 'duplicate', summary: null, nodeCount: 0, updatedAt: '2026-08-01T00:00:00Z' },
    { slug: 'UPPER', title: 'not canonical', summary: null, nodeCount: 0, updatedAt: 'not-a-date' },
  ];
  const html = injectPublicExploreShell(PUBLIC_SHELL_FIXTURE, hostile);
  assert.doesNotMatch(html, /<script>alert/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(html, /etc\/passwd|traversal|duplicate|not canonical/u);
  assert.match(html, /"numberOfItems": 1/u);
  assert.doesNotMatch(html, /<\/script><script>/u);

  const many = Array.from({ length: PUBLIC_EXPLORE_ITEM_LIMIT + 10 }, (_, index) => ({
    slug: `slug-${index}`,
    title: `Title ${index}`,
    summary: null,
    nodeCount: index,
    updatedAt: '2026-08-01T00:00:00Z',
  }));
  assert.equal(normalizeExploreItems(many).length, PUBLIC_EXPLORE_ITEM_LIMIT);
});

test('summaries in the list are bounded like meta descriptions and the empty list is honest', () => {
  const longSummary = `${'Sentence one is long enough to matter. '.repeat(6)}Trailing fragment without a period`;
  const [normalized] = normalizeExploreItems([{ ...items[0], summary: longSummary }]);
  assert.ok(normalized);
  assert.ok(normalized.summary.length <= 160);
  assert.ok(normalized.summary.endsWith('.'));
  assert.equal(normalized.summary, truncatePublicShellDescription(longSummary));

  const html = injectPublicExploreShell(PUBLIC_SHELL_FIXTURE, []);
  assert.match(html, /<p>No public collections yet\.<\/p>/u);
  assert.match(html, /"numberOfItems": 0/u);
});

test('markdown variant lists the same items with site-relative links', () => {
  const markdown = buildPublicExploreMarkdown(items);
  assert.match(markdown, /^# Explore collections\n/u);
  assert.match(markdown, /- \[LLM learning path\]\(\/c\/llm-learning-path\) — From intuition to Transformers\. Then alignment and fine-tuning for engineers\. · 34 items · updated 2026-08-29/u);
  assert.match(markdown, /- \[Design \\\[inspiration\\\] &lt;b&gt;\]\(\/c\/design-inspiration\) · 1 item · updated 2026-08-30/u);
  assert.match(markdown, /\[\/sitemap-collections\.xml\]\(\/sitemap-collections\.xml\)/u);
  assert.match(markdown, /\[llms\.txt\]\(\/llms\.txt\)\n$/u);
  assert.match(buildPublicExploreMarkdown([]), /No public collections yet\./u);
});

test('title and description match what the hydrated Explore page writes into the head', () => {
  const explore = readFileSync(
    new URL('../../../../Known-Frontend/web/src/pages/Explore.tsx', import.meta.url),
    'utf8',
  );
  const useDocumentTitle = readFileSync(
    new URL('../../../../Known-Frontend/web/src/lib/useDocumentTitle.ts', import.meta.url),
    'utf8',
  );
  assert.match(explore, /documentTitle="Explore"/u);
  assert.ok(explore.includes(`description: '${PUBLIC_EXPLORE_DESCRIPTION}'`));
  assert.match(useDocumentTitle, /`\$\{title\} — Know-N`/u);
  assert.equal(PUBLIC_EXPLORE_TITLE, 'Explore — Know-N');
});
