import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildReportsSitemapUrlset,
  ReportSitemapLimitError,
} from '../../../src/infrastructure/http/public-shell/reports-sitemap.js';
import type { PublicReportShellSeries } from '../../../src/infrastructure/http/public-shell/public-report-shell.js';

function report(overrides: Partial<PublicReportShellSeries> = {}): PublicReportShellSeries {
  return {
    id: 'series-1',
    slug: 'daily-news',
    title: 'Daily news',
    summary: null,
    visibility: 'public',
    indexable: true,
    updatedAt: '2026-09-04T00:00:00.000Z',
    issues: [{
      id: 'edition-1',
      title: 'Issue',
      summary: null,
      publishedAt: '2026-09-03T00:00:00.000Z',
      url: '/reports/daily-news/issues/edition-1',
    }],
    ...overrides,
  };
}

test('report sitemap always includes the directory and only indexable issues', () => {
  const xml = buildReportsSitemapUrlset([
    report(),
    report({ id: 'hidden', slug: 'hidden', indexable: false }),
  ]);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/reports<\/loc>/u);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/reports\/daily-news<\/loc>/u);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/reports\/daily-news\/issues\/edition-1<\/loc>/u);
  assert.doesNotMatch(xml, /hidden/u);
  assert.match(xml, /<lastmod>2026-09-04T00:00:00\.000Z<\/lastmod>/u);
});

test('empty report catalog has a valid directory URL without fabricated lastmod', () => {
  const xml = buildReportsSitemapUrlset([]);
  assert.equal((xml.match(/<url>/gu) ?? []).length, 1);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/reports<\/loc>/u);
  assert.doesNotMatch(xml, /<lastmod>/u);
});

test('report sitemap escapes locators and enforces URL/byte ceilings', () => {
  const escaped = buildReportsSitemapUrlset([report({ slug: 'a&b' })]);
  assert.match(escaped, /a&amp;b/u);
  assert.throws(
    () => buildReportsSitemapUrlset(Array.from({ length: 25_001 }, (_, index) => report({ id: String(index), slug: `report-${index}` }))),
    ReportSitemapLimitError,
  );
});
