export const DEFAULT_LINK_PREVIEW_R2_PREFIX = 'link-previews/';
/**
 * Preview objects are served `immutable` for a year, so a displaced version
 * must outlive every cached copy before GC may delete it.
 */
export const LINK_PREVIEW_MIN_RETENTION_SECONDS = 31_536_000;

export interface LinkPreviewFeatureConfig {
  /** `KNOWN_FEATURE_LINK_PREVIEW`; off means 404 routes, null fields, no worker loop. */
  readonly enabled: boolean;
  /** Public object-key prefix in the shared public-object bucket. */
  readonly r2Prefix: string;
  /** Worker global concurrency cap (default 2). */
  readonly workerConcurrency: number;
  /** Minimum interval between page fetches on the same host (default 2s). */
  readonly perHostGapMs: number;
  /** How long a displaced object stays readable before GC may delete it. */
  readonly retentionSeconds: number;
}

export function loadLinkPreviewFeatureConfig(env: NodeJS.ProcessEnv): LinkPreviewFeatureConfig {
  const flag = (env.KNOWN_FEATURE_LINK_PREVIEW ?? 'false').trim().toLowerCase();
  if (flag !== 'true' && flag !== 'false') {
    throw new Error('KNOWN_FEATURE_LINK_PREVIEW must be true or false');
  }
  const r2Prefix = env.LINK_PREVIEW_R2_PREFIX?.trim() || DEFAULT_LINK_PREVIEW_R2_PREFIX;
  if (!r2Prefix.endsWith('/') || r2Prefix.startsWith('/')) {
    throw new Error('LINK_PREVIEW_R2_PREFIX must be a relative key prefix ending in /');
  }
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  };
  return Object.freeze({
    enabled: flag === 'true',
    r2Prefix,
    workerConcurrency: integer('LINK_PREVIEW_CONCURRENCY', 2, 1, 8),
    perHostGapMs: integer('LINK_PREVIEW_HOST_GAP_MS', 2_000, 0, 60_000),
    retentionSeconds: integer(
      'LINK_PREVIEW_RETENTION_SECONDS',
      LINK_PREVIEW_MIN_RETENTION_SECONDS,
      LINK_PREVIEW_MIN_RETENTION_SECONDS,
      5 * LINK_PREVIEW_MIN_RETENTION_SECONDS,
    ),
  });
}
