import type { CaptureExistence, CaptureLocation, QueryCoverage } from './contracts.js';

export interface ExistencePorts {
  local(url: string): Promise<readonly CaptureLocation[]>;
  cloud?(url: string): Promise<{ readonly locations: readonly CaptureLocation[];
    readonly collectionIds: readonly string[]; readonly complete: boolean; readonly stale: boolean }>;
  now(): number;
}

/** Local saves use only the browser; an explicitly supplied cloud query remains informational. */
export async function queryCaptureExistence(url: string, ports: ExistencePorts): Promise<CaptureExistence> {
  const [local, cloud] = await Promise.allSettled([ports.local(url), ports.cloud?.(url) ?? Promise.resolve(null)]);
  const remote = cloud.status === 'fulfilled' ? cloud.value : null;
  const locations = [...(local.status === 'fulfilled' ? local.value : []),
    ...(remote?.locations ?? [])];
  const exact = new Map<string, CaptureLocation>();
  const similar: CaptureLocation[] = [];
  for (const location of locations) {
    if (location.url !== url) { similar.push(location); continue; }
    const key = location.nodeId && location.collectionId
      ? JSON.stringify(['cloud', location.collectionId, location.nodeId])
      : JSON.stringify(['native', location.nativeId]);
    const previous = exact.get(key);
    // Keep the native projection when the same canonical node is seen through both reads.
    if (!previous || !previous.nativeId) exact.set(key, location);
  }
  const matches = [...exact.values()];
  const coverage: QueryCoverage = {
    local: local.status === 'fulfilled' ? 'complete' : 'unavailable',
    cloud: !ports.cloud ? 'not-checked' : remote ? remote.complete ? 'complete' : 'partial' : 'unavailable',
    collectionIds: remote?.collectionIds ?? [],
    stale: remote?.stale ?? false,
    checkedAt: ports.now(),
  };
  const kind = matches.length > 1 ? 'multiple' : matches.length === 1
    ? matches[0]!.nativeId ? 'local' : 'cloud-unmapped'
    : coverage.local === 'complete' && (!ports.cloud || coverage.cloud === 'complete' && !coverage.stale) ? 'not-found' : 'unavailable';
  return { kind, exact: matches, similar, coverage };
}

export function supportedCaptureUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
