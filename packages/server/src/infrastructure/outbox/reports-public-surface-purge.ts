export { appendReportOutboxEvent, appendReportsPublicSurfacePurgeOutbox } from './reports-events.js';

export type ReportPublicSurface = 'html' | 'json' | 'sitemap' | 'og';
export interface PublicSurfacePurgeRequest {
  readonly seriesId: string;
  readonly slug: string;
  readonly revision: string;
  readonly surfaces: readonly ReportPublicSurface[];
  readonly idempotencyKey: string;
}
export interface PublicSurfacePurgePort { purge(request: PublicSurfacePurgeRequest): Promise<void>; }

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export function buildReportPublicSurfaceUrls(origin: string, slug: string, surfaces: readonly ReportPublicSurface[]): readonly string[] {
  if (!SLUG.test(slug) || slug.length > 63) throw new Error('report slug is not canonical');
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error('report public origin is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('report public origin is not an allowed HTTPS origin');
  const base = parsed.origin;
  const urls: string[] = [];
  for (const surface of surfaces) {
    if (surface === 'html') urls.push(`${base}/reports/${slug}`);
    else if (surface === 'json') urls.push(`${base}/api/v1/public-reports/${slug}`);
    else if (surface === 'sitemap') urls.push(`${base}/sitemap-reports.xml`);
    else if (surface === 'og') urls.push(`${base}/reports/${slug}`);
    else throw new Error('unsupported report purge surface');
  }
  return Object.freeze([...new Set(urls)]);
}

export function createFetchPublicSurfacePurgePort(options: {
  readonly origin: string;
  readonly endpoint: string;
  readonly bearerToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}): PublicSurfacePurgePort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return { async purge(request) {
    const urls = buildReportPublicSurfaceUrls(options.origin, request.slug, request.surfaces);
    const response = await fetchImpl(options.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': request.idempotencyKey, ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}) }, body: JSON.stringify({ urls, idempotencyKey: request.idempotencyKey }) });
    if (!response.ok) throw new Error(`report public surface purge provider returned ${response.status}`);
  } };
}
