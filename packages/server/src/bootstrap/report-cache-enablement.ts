/**
 * Shared switch for report-cache invalidation.
 *
 * Events are appended only when reports are on, Redis is not off, and at least
 * one report cache domain is enabled. Each domain flag still belongs to that
 * domain; this helper only decides whether the shared invalidation port exists.
 */
export function isReportCacheInvalidationEnabled(config: {
  readonly reports: { readonly enabled: boolean };
  readonly cache: {
    readonly redis: { readonly mode: 'off' | 'shadow' | 'serve' };
    readonly reports: {
      readonly metadataEnabled: boolean;
      readonly issuesEnabled: boolean;
      readonly directoryEnabled: boolean;
    };
  };
}): boolean {
  const reports = config.cache.reports;
  return config.reports.enabled
    && config.cache.redis.mode !== 'off'
    && (reports.metadataEnabled || reports.issuesEnabled || reports.directoryEnabled);
}
