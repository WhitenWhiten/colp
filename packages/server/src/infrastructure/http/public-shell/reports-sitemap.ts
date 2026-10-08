import type { PublicReportShellSeries } from './public-report-shell.js';

export const REPORT_SITEMAP_MAX_URLS = 50_000;
export const REPORT_SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export class ReportSitemapLimitError extends Error {
  readonly code = 'report_sitemap_limit_exceeded' as const;

  constructor() {
    super('The report sitemap exceeds the configured sitemap limits.');
    this.name = 'ReportSitemapLimitError';
  }
}

export function buildReportsSitemapUrlset(items: readonly PublicReportShellSeries[]): string {
  const eligible = items.filter((item) => item.indexable);
  const rows: string[] = [];
  const prefix = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  const suffix = '\n</urlset>\n';
  let bytes = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8');
  const append = (row: string): void => {
    const separatorBytes = rows.length === 0 ? 0 : 1;
    bytes += separatorBytes + Buffer.byteLength(row, 'utf8');
    if (rows.length + 1 > REPORT_SITEMAP_MAX_URLS || bytes > REPORT_SITEMAP_MAX_BYTES) {
      throw new ReportSitemapLimitError();
    }
    rows.push(row);
  };
  const latest = eligible
    .flatMap((item) => [item.updatedAt, ...item.issues.map((issue) => issue.publishedAt)])
    .map(Date.parse)
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);

  // The directory itself is a stable discovery URL and must remain present
  // even when there are no currently indexable reports.
  append(`<url><loc>https://know-n.com/reports</loc>${Number.isFinite(latest) ? `<lastmod>${esc(new Date(latest).toISOString())}</lastmod>` : ''}</url>`);
  for (const item of eligible) {
    append(`<url><loc>https://know-n.com/reports/${esc(item.slug)}</loc><lastmod>${esc(item.updatedAt)}</lastmod></url>`);
    for (const issue of item.issues) {
      append(`<url><loc>https://know-n.com/reports/${esc(item.slug)}/issues/${esc(issue.id)}</loc><lastmod>${esc(issue.publishedAt)}</lastmod></url>`);
    }
  }
  return `${prefix}${rows.join('\n')}${suffix}`;
}
function esc(value: string): string { return value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&apos;'); }
