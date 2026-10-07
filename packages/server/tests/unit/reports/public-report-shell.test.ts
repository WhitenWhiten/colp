import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildPublicReportMarkdown,
  injectPublicReportShell,
  type PublicReportShellSeries,
} from '../../../src/infrastructure/http/public-shell/public-report-shell.js';

const SHELL = `<!doctype html>
<html><head>
<title>Know-N</title>
<meta property="og:title" content="Know-N" />
<meta name="description" content="Know-N" />
<meta property="og:description" content="Know-N" />
<link rel="canonical" href="https://know-n.com/" />
<meta property="og:url" content="https://know-n.com/" />
<script type="application/ld+json">{"@type":"WebSite"}</script>
</head><body><main id="root">
<!-- agent-public:start -->
old
<!-- agent-public:end -->
</main></body></html>`;

function series(overrides: Partial<PublicReportShellSeries> = {}): PublicReportShellSeries {
  return {
    id: 'series-1',
    slug: 'daily-news',
    title: 'Daily news',
    summary: 'A short summary.',
    visibility: 'public',
    indexable: true,
    updatedAt: '2026-09-04T00:00:00.000Z',
    issues: [{
      id: 'edition-1',
      title: 'Issue one',
      summary: null,
      publishedAt: '2026-09-04T00:00:00.000Z',
      url: '/reports/daily-news/issues/edition-1',
    }],
    ...overrides,
  };
}

test('public report shell resolves relative issue links without Invalid URL', () => {
  const html = injectPublicReportShell(SHELL, series());
  assert.match(html, /href="\/reports\/daily-news\/issues\/edition-1"/u);
  assert.match(html, /<link rel="canonical" href="https:\/\/know-n\.com\/reports\/daily-news" \/>/u);
});

test('shell accepts same-origin absolute links and drops foreign issue authorities', () => {
  const html = injectPublicReportShell(SHELL, series({
    issues: [
      { ...series().issues[0]!, url: 'https://know-n.com/reports/daily-news/issues/edition-2?secret=1' },
      { ...series().issues[0]!, id: 'edition-3', url: 'https://evil.example/reports/daily-news/issues/edition-3' },
    ],
  }));
  assert.match(html, /href="\/reports\/daily-news\/issues\/edition-2"/u);
  assert.doesNotMatch(html, /evil\.example/u);
  assert.match(html, /<li>Issue one<\/li>/u);
});

test('issue detail can pin a canonical path while rejecting an unsafe override', () => {
  const safe = injectPublicReportShell(SHELL, series(), [], {
    canonicalPath: '/reports/daily-news/issues/edition-1',
  });
  assert.match(safe, /canonical" href="https:\/\/know-n\.com\/reports\/daily-news\/issues\/edition-1/u);

  const unsafe = injectPublicReportShell(SHELL, series(), [], {
    canonicalPath: 'https://evil.example/steal',
  });
  assert.match(unsafe, /canonical" href="https:\/\/know-n\.com\/reports\/daily-news"/u);
  assert.doesNotMatch(unsafe, /evil\.example/u);
});

test('markdown report projection remains safe for relative, foreign, and hostile values', () => {
  const markdown = buildPublicReportMarkdown(series({
    title: 'A <script>alert(1)</script>',
    issues: [
      { ...series().issues[0]!, url: '/reports/daily-news/issues/edition-1' },
      { ...series().issues[0]!, id: 'edition-2', url: 'javascript:alert(1)' },
    ],
  }));
  assert.match(markdown, /\(\/reports\/daily-news\/issues\/edition-1\)/u);
  assert.doesNotMatch(markdown, /javascript:/iu);
  assert.doesNotMatch(markdown, /<script>/iu);
});

test('directory and unlisted shell representations stay bounded and explicit', () => {
  const directory = injectPublicReportShell(SHELL, null, [series({ title: 'One' })]);
  assert.match(directory, /<h1>Digests<\/h1>/u);
  assert.match(directory, /href="\/reports\/daily-news"/u);
  assert.match(directory, /canonical" href="https:\/\/know-n\.com\/reports"/u);

  const unlisted = injectPublicReportShell(SHELL, series({ visibility: 'unlisted', indexable: false }));
  assert.match(unlisted, /name="robots" content="noindex, nofollow"/u);
  assert.match(buildPublicReportMarkdown(series({ visibility: 'unlisted', indexable: false })), /robots: noindex/iu);
});

test('empty issue lists render an honest no-issues state and JSON-LD escapes raw-text delimiters', () => {
  const html = injectPublicReportShell(SHELL, series({
    title: '</script><script>alert(1)</script>',
    issues: [],
  }));
  assert.match(html, /No published issues yet\./u);
  assert.doesNotMatch(html, /<\/script><script>alert/iu);
  assert.ok(html.includes('\\u003c/script\\u003e'));
});

test('HTML and Markdown issue lists stay bounded independently of API pagination', () => {
  const issues = Array.from({ length: 51 }, (_, index) => ({
    id: `edition-${index + 1}`,
    title: `Issue ${index + 1}`,
    summary: null,
    publishedAt: '2026-09-04T00:00:00.000Z',
    url: `/reports/daily-news/issues/edition-${index + 1}`,
  }));
  const value = series({ issues });
  const html = injectPublicReportShell(SHELL, value);
  const markdown = buildPublicReportMarkdown(value);
  assert.equal((html.match(/href="\/reports\/daily-news\/issues\//gu) ?? []).length, 50);
  assert.equal((markdown.match(/\]\(\/reports\/daily-news\/issues\//gu) ?? []).length, 50);
  assert.doesNotMatch(html, /edition-51/u);
  assert.doesNotMatch(markdown, /edition-51/u);
});

test('a hide_public tombstone renders without a link in HTML and markdown', () => {
  const tombstone = series({
    issues: [{
      id: 'edition-hidden',
      title: 'Issue hidden',
      summary: null,
      publishedAt: '2026-09-04T00:00:00.000Z',
      url: null,
      state: 'hidden',
      sourceCollectionSlug: null,
    }],
  });
  const html = injectPublicReportShell(SHELL, tombstone);
  assert.equal(html.includes('Issue hidden'), true);
  assert.equal(html.includes('issues/edition-hidden'), false);
  assert.equal(html.includes('/c/'), false);
  const markdown = buildPublicReportMarkdown(tombstone);
  assert.equal(markdown.includes('- Issue hidden'), true);
  assert.equal(markdown.includes('issues/edition-hidden'), false);
});
